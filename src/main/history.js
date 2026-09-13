const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

function dir() {
  const d = path.join(app.getPath('userData'), 'history');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const fileFor = (id) => {
  if (!/^[\w-]+$/.test(id)) throw new Error('Invalid id');
  return path.join(dir(), `${id}.json`);
};

function save(record) {
  const full = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...record };
  fs.writeFileSync(fileFor(full.id), JSON.stringify(full));
  return full;
}

function list() {
  return fs.readdirSync(dir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir(), f), 'utf8'));
        return {
          id: r.id,
          fileName: r.fileName,
          createdAt: r.createdAt,
          duration: r.duration,
          probability: r.analysis?.conversion_probability,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function get(id) {
  return JSON.parse(fs.readFileSync(fileFor(id), 'utf8'));
}

function remove(id) {
  fs.rmSync(fileFor(id), { force: true });
}

module.exports = { save, list, get, remove };
