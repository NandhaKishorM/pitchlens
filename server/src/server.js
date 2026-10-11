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

// Returns { ok, owner }. `owner` identifies the presenting client, and every job is
// scoped to it — so one client cannot read or cancel another's calls. It is a name
// from PITCHLENS_API_KEYS, never the secret. With no key configured at all there is a
// single implicit client and owner stays null.
function authenticate(req) {
  if (!config.apiKeys.length) return { ok: true, owner: null };

  const header = String(req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const a = Buffer.from(header);

  // Every key is compared, with no early exit, so the time taken does not reveal
  // which key matched or where in the list it sits.
  let matched = null;
  for (const entry of config.apiKeys) {
    const b = Buffer.from(entry.key);
    const equal = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (equal && !matched) matched = entry.name;
  }
  return { ok: !!matched, owner: matched };
}

// checkRequirements() walks PATH looking for binaries, which is far too much work to
// repeat on every upload. The answers only change when the environment does, so cache
// them briefly — long enough to matter under load, short enough that a fix to the
// setup is picked up without a restart.
let reqCache = { at: 0, problems: null };
function requirements() {
  if (reqCache.problems && Date.now() - reqCache.at < 5000) return reqCache.problems;
  reqCache = { at: Date.now(), problems: checkRequirements() };
  return reqCache.problems;
}

// Bytes being written to disk by uploads currently in flight. Caps how much a burst
// of concurrent requests can occupy before any of them is judged against the queue.
let inFlightBytes = 0;

// Cheap admission checks that must run before a single byte is read. Checking the
// queue depth inside submit() is too late: by then the upload is already on disk, so
// any number of concurrent requests could consume storage regardless of
// PITCHLENS_MAX_QUEUE. Returns an error to refuse with, or null to proceed.
function refuseBeforeBody(req, fileName) {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  if (!AUDIO_EXTS.has(ext)) return Object.assign(new Error(`Unsupported audio type: .${ext}`), { status: 415 });

  const tooBig = () => Object.assign(new Error(`Upload exceeds ${Math.round(config.maxUploadBytes / 1e6)} MB`), { status: 413 });
  const declared = Number(req.headers['content-length']);
  if (!Number.isInteger(declared) || declared <= 0) {
    return Object.assign(new Error('Upload must declare a positive content-length'), { status: 411 });
  }
  if (declared > config.maxUploadBytes) return tooBig();
  if (inFlightBytes + declared > config.maxInFlightBytes) {
    return Object.assign(new Error('Too many uploads in flight'), { status: 503 });
  }
  return null;
}

// Refusing before the body is read leaves the client still uploading, and Node drops
// the socket before the response lands. Drain the remainder so the error is delivered
// cleanly — bounded, because a declared length already over the limit is precisely
// what we must not read. Anything unbounded (chunked, or absurdly large) just closes.
function sendEarlyRefusal(req, res, err) {
  const declared = Number(req.headers['content-length']);
  if (Number.isInteger(declared) && declared > 0 && declared <= config.maxUploadBytes) req.resume();
  else res.setHeader('connection', 'close');
  send(res, err.status || 400, { error: err.message });
}

// Audio arrives as a raw body; no multipart parser needed.
function receiveUpload(req, fileName) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitchlens-upload-'));
    const dest = path.join(dir, path.basename(fileName));
    const out = fs.createWriteStream(dest);
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      inFlightBytes -= declared;
      out.destroy();
      req.destroy();
      // The temp directory has no other owner, so every exit that does not hand the
      // file to the orchestrator has to remove it here.
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      reject(err);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      inFlightBytes -= declared;
      resolve({ dest, dir, size });
    };

    inFlightBytes += declared;
    // The declared length was already bounded by refuseBeforeBody(); this catches a
    // client that lies about it and keeps streaming anyway.
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > config.maxUploadBytes) {
        fail(Object.assign(new Error(`Upload exceeds ${Math.round(config.maxUploadBytes / 1e6)} MB`), { status: 413 }));
      }
    });
    // 'aborted' rather than 'close', because 'close' also fires on a normal finish
    // and would race the success path.
    req.on('aborted', () => fail(Object.assign(new Error('Upload aborted by the client'), { status: 400 })));
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => (size ? done() : fail(Object.assign(new Error('Empty upload'), { status: 400 }))));
    req.pipe(out);
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
      // Deliberately minimal and unauthenticated: this is what a readiness probe
      // polls, and it is reachable by anyone who can reach the port. The deployment
      // inventory (engine URLs, models, metrics) is on the authenticated endpoints.
      const problems = requirements();
      return send(res, problems.length ? 503 : 200, { ok: problems.length === 0, problems });
    }

    const auth = authenticate(req);
    if (!auth.ok) return send(res, 401, { error: 'Invalid or missing API key' });

    if (route === '/v1/status' && req.method === 'GET') return send(res, 200, orchestrator.status());
    if (route === '/v1/engines' && req.method === 'GET') return send(res, 200, orchestrator.engines.status());
    if (route === '/metrics' && req.method === 'GET') return send(res, 200, orchestrator.status());

    if (route === '/v1/jobs' && req.method === 'GET') return send(res, 200, { jobs: orchestrator.list(auth.owner) });

    if (route === '/v1/jobs' && req.method === 'POST') {
      const fileName = String(req.headers['x-filename'] || url.searchParams.get('filename') || 'call.mp3');
      const problems = requirements();
      if (problems.length) return send(res, 503, { error: 'Orchestrator is not ready', problems });
      if (orchestrator.atCapacity()) return send(res, 429, { error: `Queue is full (${orchestrator.maxQueue} waiting jobs)` });
      const refused = refuseBeforeBody(req, fileName);
      if (refused) return sendEarlyRefusal(req, res, refused);
      const { dest, dir, size } = await receiveUpload(req, fileName);
      const job = orchestrator.submit({ fileName: path.basename(fileName), filePath: dest, dir, owner: auth.owner, meta: { size } });
      return send(res, 202, {
        ...orchestrator.summary(job),
        events: `/v1/jobs/${job.id}/events`,
        result: `/v1/jobs/${job.id}/result`,
      }, { location: `/v1/jobs/${job.id}` });
    }

    if (jobMatch) {
      const [, id, sub] = jobMatch;
      // A job is only visible to the credential that created it. With no API key
      // configured owner is null on both sides, so this stays a no-op for the
      // single-user loopback default.
      const job = orchestrator.get(id, auth.owner);
      if (!job) return send(res, 404, { error: 'No such job' });

      if (!sub && req.method === 'GET') {
        return send(res, 200, { ...orchestrator.summary(job), result: job.state === 'done' ? job.result : null });
      }
      if (!sub && req.method === 'DELETE') {
        return send(res, 200, { cancelled: orchestrator.cancel(id, auth.owner), ...orchestrator.summary(job) });
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

// Uploads need a long budget to finish, so requestTimeout is generous — but it is a
// real bound, not 0, so a client cannot pin a socket open indefinitely. Setting these
// to 0 (as they were) disabled Node's Slowloris protection entirely.
// Server-Sent Events are unaffected: requestTimeout only governs receiving the request
// body, and the /events GET completes its body the moment the request line is read.
server.requestTimeout = config.requestTimeoutMs;
server.headersTimeout = config.headersTimeoutMs;
server.maxConnections = config.maxConnections;

server.listen(config.port, config.host, async () => {
  const problems = checkRequirements();
  console.log(`[pitchlens] orchestrator on http://${config.host}:${config.port}`);
  console.log(`[pitchlens] engines: ${usesLocalEngines() ? 'spawned locally' : 'remote'} · concurrency ${orchestrator.concurrency} · queue limit ${orchestrator.maxQueue}`);
  if (!config.apiKeys.length && config.host !== '127.0.0.1' && config.host !== 'localhost') {
    console.warn('[pitchlens] WARNING: listening beyond loopback with no PITCHLENS_API_KEY set.');
    console.warn('[pitchlens]          Anyone who can reach this port can upload audio and read every stored job.');
    console.warn('[pitchlens]          Set PITCHLENS_API_KEY, and put it behind TLS before exposing it to a network.');
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
