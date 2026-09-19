const coreConfig = require('../../src/core/config');

const num = (value, fallback) => (value === undefined || value === '' ? fallback : Number(value));
const bool = (value, fallback) => (value === undefined || value === '' ? fallback : /^(1|true|yes)$/i.test(value));

module.exports = {
  host: process.env.PITCHLENS_HOST || '127.0.0.1',
  port: num(process.env.PITCHLENS_PORT, 8787),
  apiKey: process.env.PITCHLENS_API_KEY || '',

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

  // Point these at llama-server instances that are already running (possibly on
  // another machine). When empty, the orchestrator spawns and supervises its own.
  engines: {
    asr: { url: (process.env.PITCHLENS_ASR_URL || '').replace(/\/$/, '') },
    llm: { url: (process.env.PITCHLENS_LLM_URL || '').replace(/\/$/, '') },
  },

  models: { asr: coreConfig.asr.model, llm: coreConfig.llm.model },
};
