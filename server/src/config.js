const coreConfig = require('../../src/core/config');

const num = (value, fallback) => (value === undefined || value === '' ? fallback : Number(value));
const bool = (value, fallback) => (value === undefined || value === '' ? fallback : /^(1|true|yes)$/i.test(value));

// One shared key means every client is the same principal, so jobs could not be
// scoped to whoever uploaded them. PITCHLENS_API_KEYS takes `name:secret` pairs so
// each client gets its own namespace; PITCHLENS_API_KEY remains the single-user form.
function parseApiKeys(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((pair) => {
      const at = pair.indexOf(':');
      return at === -1 ? null : { name: pair.slice(0, at).trim(), key: pair.slice(at + 1).trim() };
    })
    .filter((entry) => entry && entry.name && entry.key);
}

const apiKeys = [
  ...parseApiKeys(process.env.PITCHLENS_API_KEYS),
  ...(process.env.PITCHLENS_API_KEY ? [{ name: 'default', key: process.env.PITCHLENS_API_KEY }] : []),
];

module.exports = {
  host: process.env.PITCHLENS_HOST || '127.0.0.1',
  port: num(process.env.PITCHLENS_PORT, 8787),
  apiKey: process.env.PITCHLENS_API_KEY || '',
  apiKeys,

  // Orchestrator behaviour
  concurrency: num(process.env.PITCHLENS_CONCURRENCY, 1),
  maxQueue: num(process.env.PITCHLENS_MAX_QUEUE, 20),
  jobTimeoutMs: num(process.env.PITCHLENS_JOB_TIMEOUT_S, 1800) * 1000,
  jobTtlMs: num(process.env.PITCHLENS_JOB_TTL_S, 3600) * 1000,
  // Stop locally spawned engines after this long with no work (0 disables).
  idleUnloadMs: num(process.env.PITCHLENS_IDLE_UNLOAD_S, 900) * 1000,
  keepResults: bool(process.env.PITCHLENS_KEEP_RESULTS, false),
  resultsDir: process.env.PITCHLENS_RESULTS_DIR || '',
  maxUploadBytes: num(process.env.PITCHLENS_MAX_UPLOAD_MB, 300) * 1024 * 1024,

  // Upload admission control. Bytes in flight are capped across all requests so a
  // burst of concurrent uploads cannot fill the disk before the queue limit is seen.
  maxInFlightBytes: num(process.env.PITCHLENS_MAX_INFLIGHT_MB, 1200) * 1024 * 1024,

  // HTTP connection limits. Uploads get a long request budget; everything else must
  // finish its headers quickly so slow clients cannot pin sockets indefinitely.
  maxConnections: num(process.env.PITCHLENS_MAX_CONNECTIONS, 256),
  headersTimeoutMs: num(process.env.PITCHLENS_HEADERS_TIMEOUT_S, 30) * 1000,
  requestTimeoutMs: num(process.env.PITCHLENS_REQUEST_TIMEOUT_S, 900) * 1000,

  // Retention caps. The TTL alone lets a busy server hold every transcript it ever
  // produced; these bound the store independently of how long that is.
  maxJobs: num(process.env.PITCHLENS_MAX_JOBS, 200),
  maxEventsPerJob: num(process.env.PITCHLENS_MAX_JOB_EVENTS, 2000),

  // Point these at llama-server instances that are already running (possibly on
  // another machine). When empty, the orchestrator spawns and supervises its own.
  engines: {
    asr: { url: (process.env.PITCHLENS_ASR_URL || '').replace(/\/$/, '') },
    llm: { url: (process.env.PITCHLENS_LLM_URL || '').replace(/\/$/, '') },
  },

  models: { asr: coreConfig.asr.model, llm: coreConfig.llm.model },
};
