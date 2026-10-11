const fs = require('fs');
const path = require('path');

// Talks to a Pitchlens orchestrator: upload the audio, follow the job's progress
// stream, then fetch the finished report. Emits the same events as the local
// pipeline so the UI does not care which one produced them.
function authHeaders(server, extra = {}) {
  return { ...(server.apiKey ? { 'x-api-key': server.apiKey } : {}), ...extra };
}

async function runRemotePipeline({ file, server, signal, emit = () => {} }) {
  const base = server.url.replace(/\/$/, '');
  const t0 = performance.now();

  emit({ stage: 'prepare', status: 'Uploading to server' });
  const upload = await fetch(`${base}/v1/jobs`, {
    method: 'POST',
    headers: authHeaders(server, { 'content-type': 'application/octet-stream', 'x-filename': path.basename(file) }),
    body: fs.createReadStream(file),
    duplex: 'half',
    signal,
  });
  const job = await upload.json();
  if (!upload.ok) throw new Error(job.error || `Server rejected the upload (HTTP ${upload.status})`);

  // Tell the server to stop working if the user cancels here.
  const onAbort = () => {
    fetch(`${base}/v1/jobs/${job.id}`, { method: 'DELETE', headers: authHeaders(server) }).catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    await followEvents({ base, server, job, signal, emit });
    const res = await fetch(`${base}/v1/jobs/${job.id}/result`, { headers: authHeaders(server), signal });
    const result = await res.json();
    if (!res.ok) throw new Error(result.message || result.error || `Server error ${res.status}`);
    result.stats = { ...result.stats, transportMs: Math.round(performance.now() - t0 - (result.stats?.totalMs || 0)), server: base };
    return result;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

async function followEvents({ base, server, job, signal, emit }) {
  const res = await fetch(`${base}/v1/jobs/${job.id}/events`, { headers: authHeaders(server), signal });
  if (!res.ok) throw new Error(`Could not follow job progress (HTTP ${res.status})`);

  const reader = res.body.getReader();
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
      if (line.startsWith('event: ')) {
        event = line.slice(7);
        continue;
      }
      if (!line.startsWith('data: ')) continue;
      const data = JSON.parse(line.slice(6));
      if (event === 'progress') emit(data);
      else if (event === 'state' && data.state === 'queued') {
        emit({ stage: 'prepare', status: data.position > 1 ? `Waiting for the server · position ${data.position}` : 'Waiting for the server' });
      } else if (event === 'state' && data.state === 'running') emit({ stage: 'prepare', status: 'Preparing audio' });
      else if (event === 'error') throw new Error(data.message || 'The server failed to analyze this call');
      else if (event === 'cancelled') throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    }
  }
}

// The orchestrator's /health is intentionally minimal and unauthenticated, so the
// deployment inventory (engines, queue, metrics) lives behind auth. Ask for it when a
// key is configured, falling back to /health so this still works against an older
// orchestrator that has not split the two yet.
async function serverHealth(server, { signal } = {}) {
  const base = server.url.replace(/\/$/, '');
  const routes = server.apiKey ? ['/v1/status', '/health'] : ['/health'];
  let res;
  for (const route of routes) {
    res = await fetch(`${base}${route}`, { headers: authHeaders(server), signal });
    if (res.status !== 404) break;
  }
  const body = await res.json();
  return { ...body, url: base, reachable: true };
}

module.exports = { runRemotePipeline, serverHealth };
