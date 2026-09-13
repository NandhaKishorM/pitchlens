const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareAudio } = require('./audio');
const { transcribe } = require('./transcribe');
const { analyze } = require('./analyze');

// Runs audio → transcript → coaching analysis. `emit` receives progress events.
async function runPipeline({ file, engines, signal, emit = () => {} }) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitchlens-'));
  const t0 = performance.now();
  const stats = {};
  try {
    emit({ stage: 'prepare', status: 'Preparing audio' });
    // Model loading is kicked off at app start; await it alongside audio prep.
    const [{ duration, chunks }] = await Promise.all([
      prepareAudio(file, workDir, { signal }),
      engines.asr.start(),
      engines.llm.start(),
    ]);
    stats.prepareMs = Math.round(performance.now() - t0);
    stats.duration = duration;
    stats.chunks = chunks.length;

    const tAsr = performance.now();
    emit({ stage: 'transcribe', status: 'Transcribing', done: 0, total: chunks.length, duration });
    const segments = await transcribe(engines.asr, chunks, {
      signal,
      onChunk: (done, total, segment) => emit({ stage: 'transcribe', status: 'Transcribing', done, total, segment }),
    });
    stats.asrMs = Math.round(performance.now() - tAsr);

    const tLlm = performance.now();
    let lastEmit = 0;
    emit({ stage: 'analyze', status: 'Analyzing call', tokens: 0 });
    const { analysis, timings } = await analyze(engines.llm, segments, {
      duration,
      signal,
      onStatus: (status) => emit({ stage: 'analyze', status }),
      onToken: (tokens, text) => {
        const now = performance.now();
        if (now - lastEmit > 80) {
          lastEmit = now;
          emit({ stage: 'analyze', status: 'Analyzing call', tokens, partial: text });
        }
      },
    });
    stats.llmMs = Math.round(performance.now() - tLlm);
    if (timings) {
      stats.promptTokens = timings.prompt_n;
      stats.promptTps = Math.round(timings.prompt_per_second);
      stats.outputTokens = timings.predicted_n;
      stats.outputTps = Math.round(timings.predicted_per_second);
    }
    stats.totalMs = Math.round(performance.now() - t0);
    stats.realtimeFactor = +(stats.totalMs / 1000 / duration).toFixed(3);
    emit({ stage: 'done', status: 'Done' });
    return { duration, segments, analysis, stats };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { runPipeline };
