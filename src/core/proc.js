const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';

// Explicit paths win, e.g. PITCHLENS_LLAMA_SERVER=C:\llama\llama-server.exe
const ENV_OVERRIDES = {
  'llama-server': 'PITCHLENS_LLAMA_SERVER',
  ffmpeg: 'PITCHLENS_FFMPEG',
  ffprobe: 'PITCHLENS_FFPROBE',
};

// Apps launched from Finder/Explorer may not inherit the shell PATH, so also
// probe the usual package-manager install locations.
function extraBinDirs() {
  if (IS_WIN) {
    const env = process.env;
    const local = env.LOCALAPPDATA || '';
    return [
      path.join(local, 'Microsoft', 'WinGet', 'Links'),
      path.join(env.USERPROFILE || '', 'scoop', 'shims'),
      path.join(env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin'),
      path.join(env.ProgramFiles || 'C:\\Program Files', 'llama.cpp'),
      path.join(env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'bin'),
    ];
  }
  return ['/opt/homebrew/bin', '/usr/local/bin'];
}

function findBin(name) {
  const override = process.env[ENV_OVERRIDES[name]];
  if (override && fs.existsSync(override)) return override;

  const file = IS_WIN ? `${name}.exe` : name;
  const bundled = path.join(__dirname, '..', '..', 'bin');
  const dirs = [bundled, ...(process.env.PATH || '').split(path.delimiter), ...extraBinDirs()];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir.replace(/^"|"$/g, ''), file);
    try {
      fs.accessSync(candidate, IS_WIN ? fs.constants.F_OK : fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
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
