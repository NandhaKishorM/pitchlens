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
  if (!findBin('llama-server')) problems.push('llama-server not found (brew install llama.cpp)');
  if (!findBin('ffmpeg')) problems.push('ffmpeg not found (brew install ffmpeg)');
  if (!findBin('ffprobe')) problems.push('ffprobe not found (brew install ffmpeg)');
  for (const file of [config.asr.model, config.asr.mmproj, config.llm.model]) {
    if (!fs.existsSync(modelPath(file))) problems.push(`Missing model: models/${file}`);
  }
  return problems;
}

function createEngines() {
  const bin = findBin('llama-server');
  const asr = new LlamaServer('Speech', bin, [
    '-m', modelPath(config.asr.model),
    '--mmproj', modelPath(config.asr.mmproj),
    '-c', String(config.asr.ctx),
    '-np', String(config.asr.slots),
    '-ngl', '99',
    '--cache-ram', '0',
    '--no-warmup',
  ]);
  const llm = new LlamaServer('Analysis', bin, [
    '-m', modelPath(config.llm.model),
    '-c', String(config.llm.ctx),
    '-np', '1',
    '-ngl', '99',
    '-fa', 'on',
    '--jinja',
    '--reasoning', 'off',
    '--chat-template-kwargs', '{"enable_thinking":false}',
    '--cache-ram', '256',
  ]);
  return { asr, llm };
}

module.exports = { createEngines, checkRequirements };
