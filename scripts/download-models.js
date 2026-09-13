#!/usr/bin/env node
// One-time model download from Hugging Face. The app itself never goes online.
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const config = require('../src/core/config');

const SOURCES = {
  [config.asr.model]: 'ggml-org/Qwen3-ASR-0.6B-GGUF',
  [config.asr.mmproj]: 'ggml-org/Qwen3-ASR-0.6B-GGUF',
  [config.llm.model]: 'unsloth/Qwen3.5-2B-GGUF',
};

async function download(file, repo) {
  const dest = path.join(config.modelsDir, file);
  if (fs.existsSync(dest)) return console.log(`✓ ${file} (already present)`);
  const url = `https://huggingface.co/${repo}/resolve/main/${file}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => {
    received += c.length;
    if (total) process.stdout.write(`\r↓ ${file} ${((received / total) * 100).toFixed(1)}%`);
  });
  const tmp = `${dest}.part`;
  await pipeline(body, fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  console.log(`\r✓ ${file} (${(received / 1e6).toFixed(0)} MB)`.padEnd(70));
}

(async () => {
  fs.mkdirSync(config.modelsDir, { recursive: true });
  for (const [file, repo] of Object.entries(SOURCES)) await download(file, repo);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
