const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const EXTRA_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

// Apps launched from Finder don't inherit the shell PATH, so also probe Homebrew dirs.
function findBin(name) {
  const bundled = path.join(__dirname, '..', '..', 'bin', name);
  const dirs = [path.dirname(bundled), ...(process.env.PATH || '').split(path.delimiter), ...EXTRA_BIN_DIRS];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function abortError() {
  const err = new Error('Cancelled');
  err.name = 'AbortError';
  return err;
}

function run(bin, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(abortError());
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${path.basename(bin)} exited with code ${code}: ${stderr.slice(-600)}`));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { findBin, run, abortError, sleep };
