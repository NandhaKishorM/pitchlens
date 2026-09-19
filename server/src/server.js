const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const config = require('./config');
const { checkRequirements, usesLocalEngines } = require('./engines');
const { Orchestrator, QueueFullError } = require('./orchestrator');

const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'webm', 'mp4', 'mov', 'wma', 'amr', 'caf', 'aiff']);
const orchestrator = new Orchestrator();

const send = (res, status, body, headers = {}) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers });
  res.end(payload);
};

function authorized(req) {
  if (!config.apiKey) return true;
  const header = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  // Constant-time compare so the key cannot be guessed byte by byte.
  const a = Buffer.from(String(header));
  const b = Buffer.from(config.apiKey);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Audio arrives as a raw body; no multipart parser needed.
function receiveUpload(req, fileName) {
  return new Promise((resolve, reject) => {
    const ext = path.extname(fileName).slice(1).toLowerCase();
    if (!AUDIO_EXTS.has(ext)) return reject(Object.assign(new Error(`Unsupported audio type: .${ext}`), { status: 415 }));
    const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pitchlens-upload-')), path.basename(fileName));
    const out = fs.createWriteStream(dest);
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > config.maxUploadBytes) {
        out.destroy();
        fs.rmSync(dest, { force: true });
        req.destroy();
        reject(Object.assign(new Error(`Upload exceeds ${Math.round(config.maxUploadBytes / 1e6)} MB`), { status: 413 }));
      }
    });
    req.on('error', reject);
    req.pipe(out);
    out.on('error', reject);
    out.on('finish', () => (size ? resolve({ dest, size }) : reject(Object.assign(new Error('Empty upload'), { status: 400 }))));
  });
}

function streamJob(req, res, job) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const write = (event) => res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);

  // Replay what already happened, then follow live.
  const since = Number(req.headers['last-event-id'] || new URL(req.url, 'http://x').searchParams.get('since') || 0);
  for (const event of job.events) if (event.seq > since) write(event);

  if (['done', 'error', 'cancelled'].includes(job.state)) return res.end();

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15_000);
  const unsubscribe = orchestrator.subscribe(job, (event) => {
    write(event);
    if (event.type === 'close') {
      clearInterval(keepAlive);
      res.end();
    }
  });
  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname.replace(/\/+$/, '') || '/';
  const jobMatch = route.match(/^\/v1\/jobs\/([\w-]+)(\/events|\/result)?$/);

  try {
    if (route === '/health' && req.method === 'GET') {
      const problems = checkRequirements();
      return send(res, problems.length ? 503 : 200, {
        ok: problems.length === 0,
        problems,
        mode: usesLocalEngines() ? 'local-engines' : 'remote-engines',
        ...orchestrator.status(),
      });
    }

    if (!authorized(req)) return send(res, 401, { error: 'Invalid or missing API key' });

    if (route === '/v1/engines' && req.method === 'GET') return send(res, 200, orchestrator.engines.status());
    if (route === '/metrics' && req.method === 'GET') return send(res, 200, orchestrator.status());

    if (route === '/v1/jobs' && req.method === 'GET') return send(res, 200, { jobs: orchestrator.list() });

    if (route === '/v1/jobs' && req.method === 'POST') {
      const fileName = String(req.headers['x-filename'] || url.searchParams.get('filename') || 'call.mp3');
      const problems = checkRequirements();
      if (problems.length) return send(res, 503, { error: 'Orchestrator is not ready', problems });
      const { dest, size } = await receiveUpload(req, fileName);
      const job = orchestrator.submit({ fileName: path.basename(fileName), filePath: dest, meta: { size } });
      return send(res, 202, {
        ...orchestrator.summary(job),
        events: `/v1/jobs/${job.id}/events`,
        result: `/v1/jobs/${job.id}/result`,
      }, { location: `/v1/jobs/${job.id}` });
    }

    if (jobMatch) {
      const [, id, sub] = jobMatch;
      const job = orchestrator.get(id);
      if (!job) return send(res, 404, { error: 'No such job' });

      if (!sub && req.method === 'GET') {
        return send(res, 200, { ...orchestrator.summary(job), result: job.state === 'done' ? job.result : null });
      }
      if (!sub && req.method === 'DELETE') {
        return send(res, 200, { cancelled: orchestrator.cancel(id), ...orchestrator.summary(job) });
      }
      if (sub === '/events' && req.method === 'GET') return streamJob(req, res, job);
      if (sub === '/result' && req.method === 'GET') {
        if (job.state === 'done') return send(res, 200, job.result);
        return send(res, 409, { error: `Job is ${job.state}`, state: job.state, message: job.error });
      }
    }

    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    if (err instanceof QueueFullError) return send(res, 429, { error: err.message });
    if (!res.headersSent) return send(res, err.status || 500, { error: err.message });
    res.end();
  }
});

server.requestTimeout = 0;
server.headersTimeout = 0;

server.listen(config.port, config.host, async () => {
  const problems = checkRequirements();
  console.log(`[pitchlens] orchestrator on http://${config.host}:${config.port}`);
  console.log(`[pitchlens] engines: ${usesLocalEngines() ? 'spawned locally' : 'remote'} · concurrency ${orchestrator.concurrency} · queue limit ${orchestrator.maxQueue}`);
  if (!config.apiKey && config.host !== '127.0.0.1' && config.host !== 'localhost') {
    console.warn('[pitchlens] WARNING: listening beyond loopback with no PITCHLENS_API_KEY set — anyone who can reach this port can send audio.');
  }
  if (problems.length) {
    console.warn('[pitchlens] not ready:\n  - ' + problems.join('\n  - '));
    return;
  }
  if (process.env.PITCHLENS_WARM !== '0') {
    try {
      await orchestrator.warm();
      console.log('[pitchlens] engines ready:', Object.values(orchestrator.engines.status()).map((e) => `${e.name} ${e.state}`).join(' · '));
    } catch (err) {
      console.error('[pitchlens] engine start failed:', err.message);
    }
  }
});

const shutdown = () => {
  console.log('\n[pitchlens] shutting down');
  orchestrator.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { server, orchestrator };
