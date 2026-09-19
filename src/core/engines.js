const fs = require('fs');
const path = require('path');
const config = require('./config');
const { findBin } = require('./proc');
const { LlamaServer } = require('./llamaServer');

function modelPath(file) {
  return path.join(config.modelsDir, file);
}

// Returns a list of human-readable problems that prevent the engines from running.
function checkRequirements() {
  const problems = [];
  const install = {
    darwin: { llama: 'brew install llama.cpp', ffmpeg: 'brew install ffmpeg' },
    win32: { llama: 'winget install llama.cpp', ffmpeg: 'winget install ffmpeg' },
  }[process.platform] || { llama: 'install llama.cpp', ffmpeg: 'install ffmpeg' };
  if (!findBin('llama-server')) problems.push(`llama-server not found (${install.llama}, or set PITCHLENS_LLAMA_SERVER)`);
  if (!findBin('ffmpeg')) problems.push(`ffmpeg not found (${install.ffmpeg}, or set PITCHLENS_FFMPEG)`);
  if (!findBin('ffprobe')) problems.push(`ffprobe not found (${install.ffmpeg}, or set PITCHLENS_FFPROBE)`);
  for (const file of [config.asr.model, config.asr.mmproj, config.llm.model]) {
    if (!fs.existsSync(modelPath(file))) problems.push(`Missing model: models/${file}`);
  }
  return problems;
}

// Shared argument sets so the app and the orchestrator start identical engines.
function engineSpecs() {
  return {
    asr: {
      name: 'Speech',
      args: [
        '-m', modelPath(config.asr.model),
        '--mmproj', modelPath(config.asr.mmproj),
        '-c', String(config.asr.ctx),
        '-np', String(config.asr.slots),
        '-ngl', '99',
        '--cache-ram', '0',
        '--no-warmup',
      ],
    },
    llm: {
      name: 'Analysis',
      args: [
        '-m', modelPath(config.llm.model),
        '-c', String(config.llm.ctx),
        '-np', '1',
        '-ngl', '99',
        '-fa', 'on',
        '--jinja',
        '--reasoning', 'off',
        '--chat-template-kwargs', '{"enable_thinking":false}',
        '--cache-ram', '256',
      ],
    },
  };
}

function createEngines() {
  const bin = findBin('llama-server');
  const specs = engineSpecs();
  return {
    asr: new LlamaServer(specs.asr.name, bin, specs.asr.args),
    llm: new LlamaServer(specs.llm.name, bin, specs.llm.args),
  };
}

module.exports = { createEngines, checkRequirements, engineSpecs, modelPath };
