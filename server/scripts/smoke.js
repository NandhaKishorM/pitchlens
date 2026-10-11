#!/usr/bin/env node
// End-to-end check against a running orchestrator:
//   node scripts/smoke.js ../samples/helpline_call.mp3 [http://127.0.0.1:8787]
const fs = require('fs');
const path = require('path');

const file = path.resolve(process.argv[2] || '../samples/helpline_call.mp3');
const base = (process.argv[3] || process.env.PITCHLENS_SERVER_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const key = process.env.PITCHLENS_API_KEY || '';
const auth = key ? { 'x-api-key': key } : {};

(async () => {
  // /health is deliberately minimal and unauthenticated; the engine inventory is
  // behind auth on /v1/status.
  const health = await (await fetch(`${base}/v1/status`, { headers: auth })).json();
  console.log('health:', health.ok, '· mode:', health.mode, '· engines:', Object.values(health.engines || {}).map((e) => `${e.name}=${e.state}`).join(' '));

  const t0 = Date.now();
  const res = await fetch(`${base}/v1/jobs`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/octet-stream', 'x-filename': path.basename(file) },
    body: fs.createReadStream(file),
    duplex: 'half',
  });
  const job = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(job));
  console.log('job:', job.id, '· state:', job.state, '· queue position:', job.position);

  const events = await fetch(`${base}${job.events}`, { headers: auth });
  const reader = events.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trimEnd();
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('event: ')) event = line.slice(7);
      if (!line.startsWith('data: ')) continue;
      const data = JSON.parse(line.slice(6));
      if (event === 'progress' && data.stage === 'transcribe' && data.total) process.stdout.write(`\r  transcribe ${data.done}/${data.total}   `);
      else if (event === 'progress' && data.stage === 'analyze') process.stdout.write(`\r  analyze ${data.tokens || 0} tokens   `);
      else if (event === 'state') console.log(`\n  state: ${data.state}${data.position ? ` (position ${data.position})` : ''}`);
      else if (event === 'error') console.error('\n  error:', data.message);
    }
  }

  const result = await (await fetch(`${base}/v1/jobs/${job.id}/result`, { headers: auth })).json();
  if (result.error) throw new Error(result.error + (result.message ? `: ${result.message}` : ''));
  const a = result.analysis;
  console.log(`\n\nwall clock: ${((Date.now() - t0) / 1000).toFixed(1)}s · pipeline: ${(result.stats.totalMs / 1000).toFixed(1)}s`);
  console.log(`audio ${result.stats.duration.toFixed(0)}s · asr ${result.stats.asrMs} ms · llm ${result.stats.llmMs} ms @ ${result.stats.outputTps} tok/s`);
  console.log(`probability ${a.conversion_probability}% · ${a.mistakes.length} mistakes · ${result.segments.length} segments`);
  console.log(`summary: ${a.summary.slice(0, 180)}…`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
