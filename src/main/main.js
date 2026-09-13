const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, ipcMain, dialog, session, clipboard, shell } = require('electron');
const { renderPdf } = require('./reportPdf');
const config = require('../core/config');
const { createEngines, checkRequirements } = require('../core/engines');
const { runPipeline } = require('../core/pipeline');
const history = require('./history');

const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'webm', 'mp4', 'mov', 'wma', 'amr', 'caf', 'aiff'];

let win = null;
let engines = null;
let problems = [];
const jobs = new Map();

// Zero egress: the renderer may only load local resources. The model servers
// are spawned by the main process on 127.0.0.1 and are not reachable from the page.
function lockDownNetwork() {
  const ses = session.defaultSession;
  const allowed = /^(file|data|blob|devtools|chrome-extension):/;
  ses.webRequest.onBeforeRequest((details, callback) => {
    const ok = allowed.test(details.url);
    if (!ok) console.warn('[egress blocked]', details.url);
    callback({ cancel: !ok });
  });
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}

function engineStatus() {
  const pick = (s) => (s ? { state: s.state, error: s.error, loadMs: s.loadMs, lastLog: s.log.at(-1) || '' } : { state: 'unavailable' });
  return {
    problems,
    asr: pick(engines?.asr),
    llm: pick(engines?.llm),
    models: { asr: config.asr.model, llm: config.llm.model },
  };
}

function broadcastStatus(server) {
  if (server) console.log(`[engine] ${server.name}: ${server.state}${server.loadMs && server.state === 'ready' ? ` in ${server.loadMs} ms` : ''}${server.error ? ` — ${server.error}` : ''}`);
  if (problems.length) console.log('[engine] setup problems:', problems);
  if (win && !win.isDestroyed()) win.webContents.send('engines:state', engineStatus());
}

function bootEngines() {
  problems = checkRequirements();
  if (problems.length) return broadcastStatus();
  if (!engines) {
    engines = createEngines();
    engines.asr.onState = broadcastStatus;
    engines.llm.onState = broadcastStatus;
  }
  for (const e of [engines.asr, engines.llm]) e.start().catch((err) => console.error(err.message));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#0a0b0d',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => (win = null));
}

function assertAudioFile(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('Invalid file');
  const stat = fs.statSync(filePath, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error('File not found');
}

ipcMain.handle('engines:status', () => engineStatus());
ipcMain.handle('engines:retry', () => {
  bootEngines();
  return engineStatus();
});

ipcMain.handle('dialog:openAudio', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose a sales call recording',
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: AUDIO_EXTS }],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('samples:list', () => {
  const dir = path.join(config.root, 'samples');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => AUDIO_EXTS.includes(path.extname(f).slice(1).toLowerCase()))
    .map((f) => ({ name: f, path: path.join(dir, f) }));
});

ipcMain.handle('analyze:start', async (event, { jobId, filePath }) => {
  assertAudioFile(filePath);
  if (problems.length) throw new Error(problems.join('\n'));
  if (!engines) bootEngines();
  const controller = new AbortController();
  jobs.set(jobId, controller);
  const send = (payload) => {
    if (!event.sender.isDestroyed()) event.sender.send('analyze:progress', { jobId, ...payload });
  };
  try {
    const result = await runPipeline({ file: filePath, engines, signal: controller.signal, emit: send });
    console.log('[pipeline]', path.basename(filePath), result.stats);
    return history.save({ fileName: path.basename(filePath), filePath, ...result });
  } finally {
    jobs.delete(jobId);
  }
});

ipcMain.handle('analyze:cancel', (_e, jobId) => {
  jobs.get(jobId)?.abort();
});

ipcMain.handle('history:list', () => history.list());
ipcMain.handle('history:get', (_e, id) => history.get(id));
ipcMain.handle('history:delete', (_e, id) => history.remove(id));
ipcMain.handle('file:url', (_e, p) => (typeof p === 'string' && fs.existsSync(p) ? pathToFileURL(p).href : null));
ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text)));
ipcMain.handle('file:reveal', (_e, p) => {
  if (typeof p === 'string' && fs.existsSync(p)) shell.showItemInFolder(p);
});

ipcMain.handle('report:exportPdf', async (_e, id) => {
  const record = history.get(id);
  const base = record.fileName.replace(/\.[^.]+$/, '');
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export call report',
    defaultPath: path.join(app.getPath('documents'), `${base} - call review.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, await renderPdf(record));
  return filePath;
});

// Dev-only: PITCHLENS_SNAPSHOT=<dir> [PITCHLENS_SNAPSHOT_FILE=<audio>] npm start
// captures the upload, progress and result screens to PNGs, then quits.
async function devSnapshot(dir) {
  const capture = async (name) => {
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, `${name}.png`), image.toPNG());
  };
  const js = (code) => win.webContents.executeJavaScript(code);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  fs.mkdirSync(dir, { recursive: true });
  // Keep painting even if the window is behind other apps, so captures aren't stale.
  win.webContents.setBackgroundThrottling(false);
  win.showInactive();
  await wait(250);
  await capture('0-loading');
  await wait(3000);
  await capture('1-upload');
  const file = process.env.PITCHLENS_SNAPSHOT_FILE;
  if (process.env.PITCHLENS_SNAPSHOT_HISTORY) {
    const first = history.list()[0];
    if (first) {
      fs.writeFileSync(path.join(dir, 'report.pdf'), await renderPdf(history.get(first.id)));
      await js(`openHistory(${JSON.stringify(first.id)})`);
      for (const [name, top] of [['3-result', 0], ['4-result-mid', 1100], ['5-result-bottom', 99999]]) {
        await js(`document.querySelector('#view-result').scrollTop = ${top}; document.querySelector('details.transcript-card')?.setAttribute('open','')`);
        await wait(top ? 900 : 2200);
        win.webContents.invalidate();
        await wait(150);
        const dom = await js(`({ scrollTop: document.querySelector('#view-result').scrollTop, buttons: [...document.querySelectorAll('.result-head .btn')].map((b) => b.textContent.trim()) })`);
        console.log(`[snapshot] ${name}`, JSON.stringify(dom));
        await capture(name);
      }
    }
  } else if (file) {
    js(`startAnalysis(${JSON.stringify(path.resolve(file))})`);
    await wait(9000);
    await capture('2-progress');
    while (!(await js(`!document.querySelector('#view-result').hidden`))) {
      if (await js(`!!document.querySelector('.error-card')`)) break;
      await wait(1000);
    }
    await wait(2500);
    await capture('3-result');
    await js(`document.querySelector('#view-result').scrollTop = 900`);
    await wait(1200);
    await capture('4-result-scrolled');
    await js(`document.querySelector('#view-result').scrollTop = 99999; document.querySelector('details.transcript-card')?.setAttribute('open','')`);
    await wait(1200);
    await capture('5-result-bottom');
  }
  app.quit();
}

app.whenReady().then(() => {
  lockDownNetwork();
  createWindow();
  bootEngines();
  if (process.env.PITCHLENS_SNAPSHOT) {
    win.webContents.once('did-finish-load', () => devSnapshot(process.env.PITCHLENS_SNAPSHOT).catch((e) => console.error(e)));
  }
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 3) console.error('[renderer]', e.message);
  });
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

function shutdown() {
  for (const c of jobs.values()) c.abort();
  engines?.asr.stop();
  engines?.llm.stop();
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', shutdown);
process.on('exit', shutdown);
