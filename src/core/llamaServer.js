const net = require('net');
const { spawn } = require('child_process');
const { sleep } = require('./proc');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// A llama-server child process bound to loopback only. Models are loaded from
// local paths, so the server never touches the network.
class LlamaServer {
  constructor(name, bin, args) {
    this.name = name;
    this.bin = bin;
    this.args = args;
    this.state = 'stopped';
    this.log = [];
    this.proc = null;
    this.port = null;
    this.startPromise = null;
    this.loadMs = null;
    this.onState = null;
  }

  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  setState(state, error) {
    this.state = state;
    this.error = error || null;
    this.onState?.(this);
  }

  start() {
    if (!this.startPromise) {
      this.startPromise = this.#boot().catch((err) => {
        // An intentional stop() during loading is not a failure.
        if (this.state !== 'stopped') {
          this.startPromise = null;
          this.setState('error', err.message);
        }
        throw err;
      });
    }
    return this.startPromise;
  }

  async #boot() {
    this.setState('loading');
    this.port = await freePort();
    const args = [...this.args, '--host', '127.0.0.1', '--port', String(this.port), '--no-webui', '--offline'];
    const t0 = Date.now();
    const proc = spawn(this.bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HF_HUB_OFFLINE: '1', LLAMA_OFFLINE: '1' },
    });
    this.proc = proc;
    let exitCode = null;
    const collect = (buf) => {
      for (const line of buf.toString().split('\n')) if (line.trim()) this.log.push(line);
      if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
    };
    proc.stdout.on('data', collect);
    proc.stderr.on('data', collect);
    proc.on('exit', (code) => {
      exitCode = code ?? -1;
      if (this.proc === proc) {
        this.proc = null;
        this.startPromise = null;
        if (this.state !== 'stopped') this.setState('error', `${this.name} engine exited (code ${exitCode})`);
      }
    });

    for (;;) {
      if (this.proc !== proc) throw new Error(`${this.name} engine was stopped while loading`);
      if (exitCode !== null) {
        throw new Error(`${this.name} engine failed to start (code ${exitCode}):\n${this.log.slice(-12).join('\n')}`);
      }
      try {
        const res = await fetch(`${this.url}/health`);
        if (res.ok) break;
      } catch {}
      if (Date.now() - t0 > 180_000) throw new Error(`${this.name} engine timed out while loading`);
      await sleep(120);
    }
    this.loadMs = Date.now() - t0;
    this.setState('ready');
    return this;
  }

  stop() {
    if (!this.proc && this.state === 'stopped') return;
    const proc = this.proc;
    this.proc = null;
    this.startPromise = null;
    this.setState('stopped');
    if (proc) proc.kill('SIGTERM');
  }
}

module.exports = { LlamaServer };
