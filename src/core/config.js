const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

module.exports = {
  root: ROOT,
  modelsDir: process.env.PITCHLENS_MODELS_DIR || path.join(ROOT, 'models'),

  // Speech-to-text: Qwen3-ASR 0.6B (Jan 2026), Q8_0 GGUF + audio projector.
  asr: {
    model: 'Qwen3-ASR-0.6B-Q8_0.gguf',
    mmproj: 'mmproj-Qwen3-ASR-0.6B-Q8_0.gguf',
    ctx: 4096,
    slots: 1,
  },

  // Analysis: Qwen3.5 2B (Feb 2026), Q4_K_M GGUF.
  llm: {
    model: 'Qwen3.5-2B-Q4_K_M.gguf',
    ctx: 16384,
    maxOutputTokens: 2048,
  },

  // Audio is cut at silences into chunks of roughly this length (seconds).
  chunk: { target: 25, min: 12, max: 35 },
};
