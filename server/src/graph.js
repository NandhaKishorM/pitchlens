const fs = require('fs');
const os = require('os');
const path = require('path');
const { StateGraph, StateSchema, START, END } = require('@langchain/langgraph');
const { z } = require('zod');

const { prepareAudio } = require('../../src/core/audio');
const { transcribe } = require('../../src/core/transcribe');
const { analyzeVoice } = require('../../src/core/prosody');
const { analyzeTranscript, condense, needsCondense, transcriptToText } = require('../../src/core/analyze');

// The pipeline as a graph: prepare → transcribe → voice → (condense) → analyze → finalize.
const PipelineState = new StateSchema({
  filePath: z.string(),
  workDir: z.string().optional(),
  wav: z.string().optional(),
  duration: z.number().optional(),
  chunks: z.array(z.any()).optional(),
  segments: z.array(z.any()).optional(),
  voice: z.any().optional(),
  transcriptText: z.string().optional(),
  label: z.string().optional(),
  analysis: z.any().optional(),
  timings: z.any().optional(),
  stats: z.any().optional(),
});

const ctx = (config) => config?.configurable ?? {};
const emit = (config, payload) => config?.writer?.(payload);

async function prepareNode(state, config) {
  const { engines, signal } = ctx(config);
  emit(config, { stage: 'prepare', status: 'Preparing audio' });
  const t0 = performance.now();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitchlens-job-'));

  // Audio preparation and model loading overlap.
  const [{ duration, chunks, wav }] = await Promise.all([
    prepareAudio(state.filePath, workDir, { signal }),
    engines.asr.start(),
    engines.llm.start(),
  ]);

  emit(config, { stage: 'transcribe', status: 'Transcribing', done: 0, total: chunks.length, duration });
  return {
    workDir,
    wav,
    duration,
    chunks,
    stats: { ...state.stats, prepareMs: Math.round(performance.now() - t0), duration, chunks: chunks.length },
  };
}

async function transcribeNode(state, config) {
  const { engines, signal } = ctx(config);
  const t0 = performance.now();
  const segments = await transcribe(engines.asr, state.chunks, {
    signal,
    onChunk: (done, total, segment) => emit(config, { stage: 'transcribe', status: 'Transcribing', done, total, segment }),
  });
  const transcriptText = transcriptToText(segments);
  if (!transcriptText.trim()) throw new Error('No speech was detected in this recording.');
  return {
    segments,
    transcriptText,
    label: 'TRANSCRIPT',
    stats: { ...state.stats, asrMs: Math.round(performance.now() - t0) },
  };
}

// Prosody: how the call sounded, measured from the audio with no model involved.
async function voiceNode(state, config) {
  const { signal } = ctx(config);
  const t0 = performance.now();
  emit(config, { stage: 'voice', status: 'Reading tone of voice', done: 0, total: 1 });
  const voice = await analyzeVoice(state.wav, {
    signal,
    onProgress: (done, total) => emit(config, { stage: 'voice', status: 'Reading tone of voice', done, total }),
  });
  return { voice, stats: { ...state.stats, voiceMs: Math.round(performance.now() - t0) } };
}

// Long calls are summarised into notes before the analysis pass.
function routeAfterVoice(state) {
  return needsCondense(state.transcriptText) ? 'condense' : 'analyze';
}

async function condenseNode(state, config) {
  const { engines, signal } = ctx(config);
  const t0 = performance.now();
  const notes = await condense(engines.llm, state.transcriptText, {
    signal,
    onStatus: (status) => emit(config, { stage: 'analyze', status }),
  });
  return {
    transcriptText: notes,
    label: 'CALL NOTES (condensed from a long transcript)',
    stats: { ...state.stats, condenseMs: Math.round(performance.now() - t0) },
  };
}

async function analyzeNode(state, config) {
  const { engines, signal } = ctx(config);
  const t0 = performance.now();
  let lastEmit = 0;
  emit(config, { stage: 'analyze', status: 'Analyzing call', tokens: 0 });
  const { analysis, timings } = await analyzeTranscript(engines.llm, state.transcriptText, {
    duration: state.duration,
    voice: state.voice,
    label: state.label,
    signal,
    onToken: (tokens, text) => {
      const now = performance.now();
      if (now - lastEmit < 80) return;
      lastEmit = now;
      emit(config, { stage: 'analyze', status: 'Analyzing call', tokens, partial: text });
    },
  });
  const stats = { ...state.stats, llmMs: Math.round(performance.now() - t0) };
  if (timings) {
    stats.promptTokens = timings.prompt_n;
    stats.promptTps = Math.round(timings.prompt_per_second);
    stats.outputTokens = timings.predicted_n;
    stats.outputTps = Math.round(timings.predicted_per_second);
  }
  return { analysis, timings, stats };
}

function finalizeNode(state, config) {
  if (state.workDir) fs.rmSync(state.workDir, { recursive: true, force: true });
  emit(config, { stage: 'done', status: 'Done' });
  return { workDir: '' };
}

const pipeline = new StateGraph(PipelineState)
  .addNode('prepare', prepareNode)
  .addNode('transcribe', transcribeNode)
  .addNode('voice', voiceNode)
  .addNode('condense', condenseNode)
  .addNode('analyze', analyzeNode)
  .addNode('finalize', finalizeNode)
  .addEdge(START, 'prepare')
  .addEdge('prepare', 'transcribe')
  .addEdge('transcribe', 'voice')
  .addConditionalEdges('voice', routeAfterVoice, { condense: 'condense', analyze: 'analyze' })
  .addEdge('condense', 'analyze')
  .addEdge('analyze', 'finalize')
  .addEdge('finalize', END)
  .compile();

// Runs the graph for one job and reports progress as it goes.
async function runPipelineGraph({ filePath, engines, signal, onEvent }) {
  const startedAt = performance.now();
  let last = null;
  try {
    const stream = await pipeline.stream(
      { filePath, stats: {} },
      { streamMode: ['custom', 'values'], configurable: { engines, signal }, signal, recursionLimit: 25 },
    );
    for await (const [mode, data] of stream) {
      if (mode === 'custom') onEvent?.('progress', data);
      else if (mode === 'values') last = data;
    }
  } finally {
    if (last?.workDir) fs.rmSync(last.workDir, { recursive: true, force: true });
  }

  if (!last?.analysis) throw new Error('Pipeline finished without producing an analysis');
  const stats = { ...last.stats, totalMs: Math.round(performance.now() - startedAt) };
  stats.realtimeFactor = last.duration ? +(stats.totalMs / 1000 / last.duration).toFixed(3) : null;
  return { duration: last.duration, segments: last.segments, analysis: last.analysis, voice: last.voice, stats };
}

module.exports = { runPipelineGraph, pipeline, PipelineState };
