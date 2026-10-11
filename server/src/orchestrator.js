const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const config = require('./config');
const { createEnginePool } = require('./engines');
const { runPipelineGraph } = require('./graph');

class QueueFullError extends Error {
  constructor(max) {
    super(`Queue is full (${max} waiting jobs)`);
    this.code = 'QUEUE_FULL';
  }
}

// True when the job has stopped and its audio can be deleted.
const isTerminal = (job) => ['done', 'error', 'cancelled'].includes(job.state);

// Owns the models and decides what runs when: one shared GPU, a queue of jobs,
// cancellation, timeouts, and unloading the engines when nothing is happening.
class Orchestrator extends EventEmitter {
  constructor(options = {}) {
    super();
    this.concurrency = Math.max(1, options.concurrency ?? config.concurrency);
    this.maxQueue = options.maxQueue ?? config.maxQueue;
    this.jobTimeoutMs = options.jobTimeoutMs ?? config.jobTimeoutMs;
    this.jobTtlMs = options.jobTtlMs ?? config.jobTtlMs;
    this.idleUnloadMs = options.idleUnloadMs ?? config.idleUnloadMs;
    this.maxJobs = options.maxJobs ?? config.maxJobs;
    this.maxEventsPerJob = options.maxEventsPerJob ?? config.maxEventsPerJob;

    this.jobs = new Map();
    this.queue = [];
    this.running = new Set();
    this.idleTimer = null;
    this.metrics = { submitted: 0, completed: 0, failed: 0, cancelled: 0, audioSeconds: 0, processingMs: 0 };

    this.engines = createEnginePool({
      onState: (engine) => this.emit('engines', { engine: engine.name, state: engine.state, error: engine.error || null }),
    });
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  async warm() {
    await this.engines.startAll();
  }

  // True when a new job would be rejected for queue depth. Callers can check this
// before doing expensive work (reading an upload) rather than after.
atCapacity() {
  return this.queue.length >= this.maxQueue;
}

submit({ fileName, filePath, dir, owner = null, meta = {} }) {
    if (this.atCapacity()) throw new QueueFullError(this.maxQueue);
    this.pruneJobs();
    const job = {
      id: crypto.randomUUID(),
      fileName,
      filePath,
      dir: dir || null,
      owner,
      meta,
      state: 'queued',
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      events: [],
      seq: 0,
      listeners: new Set(),
      controller: new AbortController(),
      result: null,
      error: null,
      timedOut: false,
    };
    this.jobs.set(job.id, job);
    this.queue.push(job);
    this.metrics.submitted++;
    this.record(job, 'state', { state: 'queued', position: this.position(job) });
    this.pump();
    return job;
  }

  // A job is visible only to the credential that created it. With no API key
  // configured both sides are null, so there is a single implicit client.
  get(id, owner) {
    const job = this.jobs.get(id);
    return job && job.owner === owner ? job : undefined;
  }

  list(owner) {
    return [...this.jobs.values()]
      .filter((job) => job.owner === owner)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((job) => this.summary(job));
  }

  position(job) {
    const index = this.queue.indexOf(job);
    return index === -1 ? 0 : index + 1;
  }

  cancel(id, owner) {
    const job = this.get(id, owner);
    if (!job || isTerminal(job)) return false;
    const queued = this.queue.indexOf(job);
    if (queued !== -1) {
      this.queue.splice(queued, 1);
      this.finish(job, 'cancelled', { error: 'Cancelled before it started' });
      this.pump();
      return true;
    }
    job.controller.abort();
    return true;
  }

  // Appends an event and pushes it to anyone streaming this job.
  record(job, type, data) {
    const event = { seq: ++job.seq, at: Date.now(), type, data };
    job.events.push(event);
    // Bound the replay buffer so one long call cannot pin memory for the whole TTL.
    // `seq` is a counter rather than events.length, so Last-Event-ID keeps working
    // across a trim; the oldest events are dropped from the middle so a reconnecting
    // client still sees how the job started as well as how it is going.
    const cap = this.maxEventsPerJob;
    if (cap > 0 && job.events.length > cap) {
      const head = Math.max(1, Math.floor(cap / 4));
      job.events = [...job.events.slice(0, head), ...job.events.slice(job.events.length - (cap - head))];
    }
    for (const listener of job.listeners) {
      try {
        listener(event);
      } catch {}
    }
    return event;
  }

  subscribe(job, listener) {
    job.listeners.add(listener);
    return () => job.listeners.delete(listener);
  }

  pump() {
    while (this.running.size < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.run(job);
    }
    // Everyone still waiting moved up a place.
    this.queue.forEach((job) => this.record(job, 'state', { state: 'queued', position: this.position(job) }));
  }

  async run(job) {
    this.running.add(job);
    job.state = 'running';
    job.startedAt = Date.now();
    this.clearIdleTimer();
    this.record(job, 'state', { state: 'running', position: 0 });

    const timeout = setTimeout(() => {
      job.timedOut = true;
      job.controller.abort();
    }, this.jobTimeoutMs);

    try {
      const result = await runPipelineGraph({
        filePath: job.filePath,
        engines: this.engines,
        signal: job.controller.signal,
        onEvent: (type, data) => this.record(job, type, data),
      });
      job.result = result;
      this.metrics.completed++;
      this.metrics.audioSeconds += result.stats.duration || 0;
      this.metrics.processingMs += result.stats.totalMs || 0;
      this.persist(job);
      this.finish(job, 'done', { stats: result.stats });
    } catch (err) {
      if (job.controller.signal.aborted && !job.timedOut) {
        this.metrics.cancelled++;
        this.finish(job, 'cancelled', { error: 'Cancelled' });
      } else if (job.timedOut) {
        this.metrics.failed++;
        this.finish(job, 'error', { error: `Timed out after ${Math.round(this.jobTimeoutMs / 1000)}s` });
      } else {
        this.metrics.failed++;
        this.finish(job, 'error', { error: err.message });
      }
    } finally {
      clearTimeout(timeout);
      this.running.delete(job);
      this.scheduleIdleUnload();
      this.pump();
    }
  }

  finish(job, state, { stats, error } = {}) {
    job.state = state;
    job.finishedAt = Date.now();
    job.error = error || null;
    this.discardAudio(job);
    this.record(job, state === 'done' ? 'done' : state, state === 'done' ? { stats } : { message: error });
    for (const listener of [...job.listeners]) {
      try {
        listener({ seq: job.seq + 1, at: Date.now(), type: 'close', data: { state } });
      } catch {}
    }
    job.listeners.clear();
    this.emit('job', this.summary(job));
  }

  // Removes a job's upload. The whole temp *directory* has to go, not just the
  // file inside it — the upload lives in a mkdtemp directory that nothing else
  // ever cleans up, so removing only the file leaks a directory per call.
  discardAudio(job) {
    const target = job.dir || job.filePath;
    if (target) fs.rmSync(target, { recursive: true, force: true });
    job.filePath = null;
    job.dir = null;
  }

  // Drops the oldest finished jobs once the store exceeds maxJobs. The TTL in
  // sweep() is the normal path; this bounds memory even when jobs arrive faster
  // than the TTL allows them to age out.
  pruneJobs() {
    if (!this.maxJobs || this.jobs.size < this.maxJobs) return;
    const finished = [...this.jobs.values()].filter((job) => isTerminal(job)).sort((a, b) => a.finishedAt - b.finishedAt);
    for (const job of finished) {
      if (this.jobs.size < this.maxJobs) break;
      this.discardAudio(job);
      this.jobs.delete(job.id);
    }
  }

  persist(job) {
    if (!config.resultsDir) return;
    try {
      fs.mkdirSync(config.resultsDir, { recursive: true });
      fs.writeFileSync(
        path.join(config.resultsDir, `${job.id}.json`),
        JSON.stringify({ id: job.id, fileName: job.fileName, createdAt: new Date(job.createdAt).toISOString(), ...job.result }, null, 2),
      );
    } catch (err) {
      console.error('[orchestrator] could not save result:', err.message);
    }
  }

  clearIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  // Free GPU memory when no work has arrived for a while.
  scheduleIdleUnload() {
    this.clearIdleTimer();
    if (!this.idleUnloadMs || this.running.size || this.queue.length) return;
    this.idleTimer = setTimeout(() => {
      if (this.running.size || this.queue.length || !this.engines.releasable()) return;
      console.log('[orchestrator] idle — unloading engines');
      this.engines.stopAll();
      this.emit('engines', { engine: 'all', state: 'unloaded' });
    }, this.idleUnloadMs);
    this.idleTimer.unref?.();
  }

  sweep() {
    const cutoff = Date.now() - this.jobTtlMs;
    // A job that never reached a terminal state — because the pipeline ignored the
    // abort signal, say — used to stay in the store forever, holding its transcript
    // and its upload. Anything still unfinished long past its timeout is stale.
    const stale = Date.now() - this.jobTimeoutMs - 60_000;
    for (const [id, job] of this.jobs) {
      const expired = job.finishedAt && job.finishedAt < cutoff;
      const stuck = !job.finishedAt && job.createdAt < stale;
      if (expired || stuck) {
        if (stuck) this.finish(job, 'error', { error: 'Job did not finish' });
        this.discardAudio(job);
        this.jobs.delete(id);
      }
    }
    this.pruneJobs();
  }

  summary(job) {
    return {
      id: job.id,
      fileName: job.fileName,
      state: job.state,
      position: job.state === 'queued' ? this.position(job) : 0,
      createdAt: new Date(job.createdAt).toISOString(),
      startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : null,
      finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
      error: job.error,
      stats: job.result?.stats || null,
    };
  }

  status() {
    return {
      engines: this.engines.status(),
      queue: {
        running: this.running.size,
        queued: this.queue.length,
        concurrency: this.concurrency,
        maxQueue: this.maxQueue,
      },
      metrics: {
        ...this.metrics,
        averageMs: this.metrics.completed ? Math.round(this.metrics.processingMs / this.metrics.completed) : 0,
      },
    };
  }

  shutdown() {
    clearInterval(this.sweeper);
    this.clearIdleTimer();
    for (const job of this.running) job.controller.abort();
    this.engines.stopAll();
  }
}

module.exports = { Orchestrator, QueueFullError };
