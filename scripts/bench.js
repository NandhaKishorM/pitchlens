#!/usr/bin/env node
// Headless benchmark: runs the same pipeline the app uses over sample audio and
// prints per-stage timings, throughput and engine memory.
//   npm run bench                 # all files in samples/
//   npm run bench -- a.mp3 b.wav  # specific files
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('../src/core/config');
const { createEngines, checkRequirements } = require('../src/core/engines');
const { runPipeline } = require('../src/core/pipeline');
const { transcriptToText } = require('../src/core/analyze');

const AUDIO = /\.(mp3|wav|m4a|ogg|opus|flac|webm|aac)$/i;

function rssMb(pid) {
  try {
    return Math.round(parseInt(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString(), 10) / 1024);
  } catch {
    return null;
  }
}

async function main() {
  const problems = checkRequirements();
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  const samplesDir = path.join(config.root, 'samples');
  const args = process.argv.slice(2);
  const files = args.length
    ? args.map((f) => path.resolve(f))
    : fs.readdirSync(samplesDir).filter((f) => AUDIO.test(f)).sort().map((f) => path.join(samplesDir, f));
  const outDir = path.join(samplesDir, 'results');
  fs.mkdirSync(outDir, { recursive: true });

  const engines = createEngines();
  const stop = () => {
    engines.asr.stop();
    engines.llm.stop();
  };
  process.on('SIGINT', () => {
    stop();
    process.exit(130);
  });

  try {
    await Promise.all([engines.asr.start(), engines.llm.start()]);
    console.log(`engines ready · speech ${engines.asr.loadMs} ms · analysis ${engines.llm.loadMs} ms`);

    const rows = [];
    for (const file of files) {
      const name = path.basename(file);
      process.stdout.write(`\n▸ ${name}\n`);
      let last = '';
      const result = await runPipeline({
        file,
        engines,
        emit: (e) => {
          const line = e.stage === 'transcribe' && e.total ? `  transcribe ${e.done}/${e.total}` : `  ${e.status}${e.tokens ? ` · ${e.tokens} tok` : ''}`;
          if (line !== last && (e.stage !== 'analyze' || !e.tokens || e.tokens % 200 === 0)) {
            process.stdout.write(`\r${line.padEnd(60)}`);
            last = line;
          }
        },
      });
      const s = result.stats;
      const a = result.analysis;
      const mem = { asr: rssMb(engines.asr.proc?.pid), llm: rssMb(engines.llm.proc?.pid) };
      console.log(`\r  audio ${s.duration.toFixed(0)}s · ${s.chunks} chunks`.padEnd(60));
      console.log(`  prepare ${s.prepareMs} ms · asr ${s.asrMs} ms (${(s.duration / (s.asrMs / 1000)).toFixed(1)}x realtime)`);
      console.log(`  llm ${s.llmMs} ms · prompt ${s.promptTokens} tok @ ${s.promptTps}/s · output ${s.outputTokens} tok @ ${s.outputTps}/s`);
      console.log(`  total ${(s.totalMs / 1000).toFixed(1)} s · rss speech ${mem.asr} MB · analysis ${mem.llm} MB`);
      console.log(`  → probability ${a.conversion_probability}% (model ${a.probability_breakdown.model}, rubric ${a.probability_breakdown.rubric}) · ${a.mistakes.length} mistakes`);
      console.log(`  → ${a.summary.slice(0, 220)}${a.summary.length > 220 ? '…' : ''}`);

      const base = path.join(outDir, name.replace(/\.[^.]+$/, ''));
      fs.writeFileSync(`${base}.json`, JSON.stringify({ file: name, ...result, mem }, null, 2));
      fs.writeFileSync(`${base}.transcript.txt`, transcriptToText(result.segments));
      rows.push({ name, audio_s: +s.duration.toFixed(0), total_s: +(s.totalMs / 1000).toFixed(1), asr_x: +(s.duration / (s.asrMs / 1000)).toFixed(1), llm_tps: s.outputTps, prob: a.conversion_probability });
    }
    console.log('');
    console.table(rows);
  } finally {
    stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
