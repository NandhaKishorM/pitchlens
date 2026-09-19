const fs = require('fs');
const coreConfig = require('../../src/core/config');
const { findBin } = require('../../src/core/proc');
const { LlamaServer } = require('../../src/core/llamaServer');
const { engineSpecs, modelPath } = require('../../src/core/engines');
const config = require('./config');

// An engine that is already running somewhere else. Same surface as LlamaServer
// so the pipeline cannot tell the difference.
class RemoteEngine {
  constructor(name, url) {
    this.name = name;
    this.url = url;
    this.remote = true;
    this.state = 'unknown';
    this.loadMs = null;
  }

  async start() {
    const t0 = Date.now();
    let res;
    try {
      res = await fetch(`${this.url}/health`);
    } catch (err) {
      this.state = 'error';
      throw new Error(`${this.name} engine unreachable at ${this.url}: ${err.message}`);
    }
    if (!res.ok) {
      this.state = 'error';
      throw new Error(`${this.name} engine at ${this.url} is not ready (HTTP ${res.status})`);
    }
    this.loadMs = Date.now() - t0;
    this.state = 'ready';
    return this;
  }

  stop() {
    // Not ours to stop.
  }
}

function usesLocalEngines() {
  return !config.engines.asr.url || !config.engines.llm.url;
}

function checkRequirements() {
  const problems = [];
  if (!findBin('ffmpeg')) problems.push('ffmpeg not found (needed to decode and split audio)');
  if (!findBin('ffprobe')) problems.push('ffprobe not found (needed to read audio duration)');
  if (usesLocalEngines()) {
    if (!findBin('llama-server')) problems.push('llama-server not found (install llama.cpp, or set PITCHLENS_ASR_URL / PITCHLENS_LLM_URL)');
    for (const file of [coreConfig.asr.model, coreConfig.asr.mmproj, coreConfig.llm.model]) {
      if (!fs.existsSync(modelPath(file))) problems.push(`Missing model: models/${file}`);
    }
  }
  return problems;
}

// The engine pool: creates the engines, starts them on demand, and can release
// GPU memory when the orchestrator has been idle.
function createEnginePool({ onState } = {}) {
  const specs = engineSpecs();
  const bin = usesLocalEngines() ? findBin('llama-server') : null;
  const build = (key) => {
    const url = config.engines[key].url;
    const engine = url ? new RemoteEngine(specs[key].name, url) : new LlamaServer(specs[key].name, bin, specs[key].args);
    engine.onState = () => onState?.(engine);
    return engine;
  };

  const asr = build('asr');
  const llm = build('llm');
  const all = [asr, llm];

  return {
    asr,
    llm,
    async startAll() {
      await Promise.all(all.map((e) => e.start()));
    },
    stopAll() {
      for (const engine of all) engine.stop();
    },
    // Only locally spawned engines are worth unloading.
    releasable() {
      return all.some((e) => !e.remote && e.state === 'ready');
    },
    status() {
      return {
        asr: describe(asr, config.models.asr),
        llm: describe(llm, config.models.llm),
      };
    },
  };
}

function describe(engine, model) {
  return {
    name: engine.name,
    kind: engine.remote ? 'remote' : 'local',
    url: engine.remote ? engine.url : engine.port ? `http://127.0.0.1:${engine.port}` : null,
    state: engine.state,
    loadMs: engine.loadMs,
    model,
    error: engine.error || null,
  };
}

module.exports = { createEnginePool, checkRequirements, usesLocalEngines, RemoteEngine };
