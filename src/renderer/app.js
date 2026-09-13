'use strict';

// The bridge is exposed under a different name: contextBridge globals are
// non-configurable, so a top-level `const` with the same name is a SyntaxError.
const api = window.pitchlens;
const $ = (sel, root = document) => root.querySelector(sel);

// Surface startup failures instead of leaving the status stuck.
function showFatal(message) {
  const btn = $('#engineStatus');
  btn.classList.add('error');
  $('.engine-text', btn).textContent = 'UI error · see tooltip';
  btn.title = message;
  console.error(message);
}
window.addEventListener('error', (e) => showFatal(`${e.message} (${e.filename}:${e.lineno})`));
window.addEventListener('unhandledrejection', (e) => showFatal(String(e.reason?.message || e.reason)));
if (!api) {
  showFatal('Preload bridge failed to load (window.pitchlens is undefined)');
  throw new Error('window.pitchlens missing');
}

const ICONS = {
  file: '<svg viewBox="0 0 24 24" class="icon"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  check: '<svg viewBox="0 0 24 24" class="icon"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  x: '<svg viewBox="0 0 24 24" class="icon"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  play: '<svg viewBox="0 0 24 24" class="icon"><path d="M7 5l12 7-12 7z"/></svg>',
  download: '<svg viewBox="0 0 24 24" class="icon"><path d="M12 4v11M7 10l5 5 5-5"/><path d="M5 20h14"/></svg>',
  copy: '<svg viewBox="0 0 24 24" class="icon"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/></svg>',
  chev: '<svg viewBox="0 0 24 24" class="icon chev"><path d="M6 9l6 6 6-6"/></svg>',
  alert: '<svg viewBox="0 0 24 24" class="icon"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg>',
  spark: '<svg viewBox="0 0 24 24" class="icon"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/></svg>',
  target: '<svg viewBox="0 0 24 24" class="icon"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" class="icon"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  shield: '<svg viewBox="0 0 24 24" class="icon"><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/></svg>',
  wave: '<svg viewBox="0 0 24 24" class="icon"><path d="M3 12h2M7 8v8M11 5v14M15 8v8M19 10v4M21 12h0"/></svg>',
};

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style') el.style.cssText = value;
    else if (key === 'icon') el.insertAdjacentHTML('afterbegin', ICONS[value]);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const fmtTime = (sec) => {
  const s = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
};
const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const basename = (p) => p.split(/[\\/]/).pop();
const cleanError = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const probColor = (p) => (p >= 60 ? 'var(--good)' : p >= 35 ? 'var(--warn)' : 'var(--bad)');
const probLabel = (p) => (p >= 76 ? 'Very likely to convert' : p >= 56 ? 'Likely to convert' : p >= 36 ? 'Uncertain' : p >= 16 ? 'Unlikely to convert' : 'Very unlikely');

let toastTimer;
function toast(message, action) {
  const el = $('#toast');
  el.replaceChildren(message);
  if (action) {
    el.append(h('button', { class: 'toast-action', onclick: () => { el.hidden = true; action.run(); } }, action.label));
  }
  el.hidden = false;
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), action ? 5000 : 2400);
}

/* ---------------- views ---------------- */

const views = ['upload', 'progress', 'result'];
function show(name, title) {
  for (const v of views) {
    const el = $(`#view-${v}`);
    const active = v === name;
    if (active) {
      el.hidden = false;
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
      el.scrollTop = 0;
    } else {
      el.hidden = true;
    }
  }
  $('#topTitle').textContent = title || 'New analysis';
  if (name !== 'result') setActiveHistory(null);
}

/* ---------------- engine status ---------------- */

let engineState = null;
function renderEngineLoad(status) {
  const panel = $('#engineLoad');
  if (status.problems?.length) {
    panel.hidden = true;
    return;
  }
  let allReady = true;
  for (const key of ['asr', 'llm']) {
    const s = status[key];
    const row = $(`.el-row[data-engine="${key}"]`, panel);
    const detail = $('.el-detail', row);
    const bar = $('.bar', row);
    const fill = $('.bar > i', row);
    $('.el-file', row).textContent = status.models[key];
    row.classList.remove('loading', 'ready', 'error');
    row.title = '';
    if (s.state === 'ready') {
      row.classList.add('ready');
      detail.textContent = `Loaded in ${(s.loadMs / 1000).toFixed(1)}s`;
      bar.classList.remove('indeterminate');
      fill.style.width = '100%';
    } else if (s.state === 'error') {
      allReady = false;
      row.classList.add('error');
      detail.textContent = 'Failed to load';
      row.title = s.error || '';
    } else {
      allReady = false;
      row.classList.add('loading');
      detail.textContent = 'Loading onto GPU…';
      bar.classList.add('indeterminate');
      fill.style.width = '';
    }
  }
  if (!allReady) {
    panel.hidden = false;
    panel.classList.remove('collapsed');
  } else if (!panel.hidden) {
    setTimeout(() => panel.classList.add('collapsed'), 1400);
  }
}

function renderEngineStatus(status) {
  engineState = status;
  renderEngineLoad(status);
  const btn = $('#engineStatus');
  const text = $('.engine-text', btn);
  btn.classList.remove('ready', 'error');

  const problems = $('#problems');
  if (status.problems?.length) {
    btn.classList.add('error');
    text.textContent = 'Setup required';
    problems.replaceChildren(
      h('strong', null, 'Pitchlens needs a few things before it can run:'),
      h('ul', null, status.problems.map((p) => h('li', null, p))),
    );
    problems.hidden = false;
    return;
  }
  problems.hidden = true;

  const states = [status.asr.state, status.llm.state];
  if (states.every((s) => s === 'ready')) {
    btn.classList.add('ready');
    text.textContent = 'Models loaded';
    btn.title = `Speech ${status.models.asr} · ${status.asr.loadMs} ms\nAnalysis ${status.models.llm} · ${status.llm.loadMs} ms`;
  } else if (states.includes('error')) {
    btn.classList.add('error');
    text.textContent = 'Engine error · retry';
    btn.title = status.asr.error || status.llm.error || '';
  } else {
    loadingSince ||= performance.now();
    const secs = Math.round((performance.now() - loadingSince) / 1000);
    text.textContent = `Loading models… ${secs}s`;
    btn.title = status.llm.lastLog || status.asr.lastLog || '';
    clearTimeout(loadingTick);
    loadingTick = setTimeout(async () => renderEngineStatus(await api.engineStatus()), 1000);
    return;
  }
  clearTimeout(loadingTick);
}
let loadingSince = 0;
let loadingTick;

$('#engineStatus').addEventListener('click', async () => {
  if ($('#engineStatus').classList.contains('error') && !engineState?.problems?.length) {
    renderEngineStatus(await api.retryEngines());
  }
});

/* ---------------- history ---------------- */

let historyItems = [];
let activeHistoryId = null;

function setActiveHistory(id) {
  activeHistoryId = id;
  for (const li of document.querySelectorAll('#historyList li')) li.classList.toggle('active', li.dataset.id === id);
}

async function loadHistory() {
  historyItems = await api.history.list();
  const list = $('#historyList');
  if (!historyItems.length) {
    list.replaceChildren(h('li', { class: 'history-empty', style: 'cursor:default;background:none' }, 'Analyzed calls appear here.'));
    return;
  }
  list.replaceChildren(...historyItems.map((item, i) => {
    const li = h('li', { 'data-id': item.id, style: `animation-delay:${i * 25}ms`, onclick: () => openHistory(item.id) },
      h('span', { class: 'h-name', title: item.fileName }, item.fileName),
      h('span', { class: 'h-prob', style: `color:${probColor(item.probability)}` }, `${item.probability}%`),
      h('span', { class: 'h-meta' }, `${fmtTime(item.duration)} · ${fmtDate(item.createdAt)}`),
      h('button', {
        class: 'h-del', title: 'Delete', icon: 'x',
        onclick: async (e) => {
          e.stopPropagation();
          await api.history.remove(item.id);
          if (activeHistoryId === item.id) show('upload');
          loadHistory();
        },
      }),
    );
    return li;
  }));
  setActiveHistory(activeHistoryId);
}

async function openHistory(id) {
  if (currentJob) return toast('An analysis is still running');
  try {
    const record = await api.history.get(id);
    renderResult(record);
    setActiveHistory(id);
  } catch (err) {
    toast(cleanError(err));
  }
}

/* ---------------- upload ---------------- */

const dropzone = $('#dropzone');
dropzone.addEventListener('click', async () => {
  const filePath = await api.pickAudio();
  if (filePath) startAnalysis(filePath);
});
for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.add('over');
  });
}
for (const type of ['dragleave', 'drop']) dropzone.addEventListener(type, () => dropzone.classList.remove('over'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const filePath = api.pathForFile(file);
  if (filePath) startAnalysis(filePath);
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

$('#newBtn').addEventListener('click', () => {
  if (currentJob) return show('progress', currentJob.name);
  show('upload');
});

async function loadSamples() {
  const samples = await api.listSamples();
  if (!samples.length) return;
  $('#samplesList').replaceChildren(...samples.map((s) =>
    h('button', { class: 'chip-btn', icon: 'play', onclick: () => startAnalysis(s.path) }, s.name)));
  $('#samplesBlock').hidden = false;
}

/* ---------------- progress ---------------- */

let currentJob = null;
const STEP_DEFS = [
  { id: 'prepare', label: 'Preparing audio' },
  { id: 'transcribe', label: 'Transcribing speech' },
  { id: 'analyze', label: 'Coaching analysis' },
];
const SECTION_LABELS = {
  summary: 'summary', call_type: 'call type', customer_needs: 'customer needs', buyer_sentiment: 'buyer sentiment',
  strengths: 'strengths', mistakes: 'mistakes', objections: 'objections', scores: 'skill scores',
  probability_reasoning: 'conversion outlook', conversion_probability: 'conversion probability',
  suggestions: 'suggestions', recommendations: 'recommendations', next_steps: 'next steps',
};

function renderProgress(job) {
  const view = $('#view-progress');
  job.el = {};
  const steps = STEP_DEFS.map((def) => {
    const detail = h('span', { class: 'step-detail' });
    const fill = h('i');
    const bar = h('div', { class: 'bar' }, fill);
    const el = h('div', { class: 'step' },
      h('div', { class: 'step-row' },
        h('span', { class: 'step-ind' }, h('span', { class: 'ring' }), h('span', { class: 'check' })),
        h('span', { class: 'step-label' }, def.label),
        detail),
      bar);
    $('.check', el).innerHTML = ICONS.check;
    job.el[def.id] = { el, detail, bar, fill };
    return el;
  });

  job.el.transcript = h('div', { class: 'live-body selectable' }, h('div', { class: 'faint' }, 'Waiting for speech…'));
  job.el.draft = h('div', { class: 'draft caret' });
  job.el.draftSection = h('span', { class: 'step-detail' });
  job.el.draftCard = h('div', { class: 'live', hidden: true },
    h('div', { class: 'live-head' }, h('span', { class: 'live-title' }, 'Drafting report'), job.el.draftSection),
    job.el.draft);
  job.el.elapsed = h('span', null, '0:00');
  job.el.meta = h('div', { class: 'file-meta' }, 'Reading file… · ', job.el.elapsed);
  job.el.body = h('div', null,
    h('div', { class: 'steps' }, steps),
    h('div', { class: 'live-grid' },
      job.el.draftCard,
      h('div', { class: 'live' },
        h('div', { class: 'live-head' }, h('span', { class: 'live-title' }, 'Live transcript')),
        job.el.transcript)));

  view.replaceChildren(h('div', { class: 'progress-wrap' },
    h('div', { class: 'file-head' },
      h('div', { class: 'file-icon', icon: 'file' }),
      h('div', { class: 'grow' }, h('div', { class: 'file-name' }, job.name), job.el.meta),
      h('button', { class: 'btn', onclick: () => api.cancel(job.id) }, 'Cancel')),
    job.el.body));

  job.timer = setInterval(() => {
    job.el.elapsed.textContent = fmtTime((performance.now() - job.startedAt) / 1000);
  }, 250);
}

function setStep(job, id) {
  const idx = STEP_DEFS.findIndex((s) => s.id === id);
  STEP_DEFS.forEach((def, i) => {
    const s = job.el[def.id].el;
    s.classList.toggle('done', i < idx || id === 'done');
    s.classList.toggle('active', i === idx);
  });
}

function partialString(text, key) {
  const m = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`));
  if (!m) return null;
  const raw = m[1].replace(/\\u?[0-9a-fA-F]{0,3}$|\\$/, '');
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

function onProgress(evt) {
  const job = currentJob;
  if (!job || evt.jobId !== job.id) return;
  setStep(job, evt.stage);

  if (evt.stage === 'transcribe') {
    if (evt.duration) {
      job.duration = evt.duration;
      job.el.meta.replaceChildren(`${fmtTime(evt.duration)} audio · `, job.el.elapsed);
    }
    const { detail, fill } = job.el.transcribe;
    if (evt.total) {
      detail.textContent = `${evt.done} / ${evt.total} segments`;
      fill.style.width = `${(evt.done / evt.total) * 100}%`;
      if (evt.done === 0) job.asrStart = performance.now();
      if (evt.done > 0 && evt.done < evt.total) {
        const per = (performance.now() - job.asrStart) / evt.done;
        detail.textContent += ` · ~${Math.ceil((per * (evt.total - evt.done)) / 1000)}s left`;
      }
    }
    if (evt.segment?.text) {
      if (!job.hasSegments) {
        job.el.transcript.replaceChildren();
        job.hasSegments = true;
      }
      const body = job.el.transcript;
      const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
      body.append(h('div', { class: 'seg' }, h('span', { class: 'seg-t' }, fmtTime(evt.segment.start)), h('span', null, evt.segment.text)));
      if (nearBottom) body.scrollTop = body.scrollHeight;
    }
  }

  if (evt.stage === 'prepare') {
    job.el.prepare.bar.classList.add('indeterminate');
  }

  if (evt.stage === 'analyze') {
    const { detail, fill, bar } = job.el.analyze;
    if (evt.tokens) {
      bar.classList.remove('indeterminate');
      const rate = evt.tokens / ((performance.now() - (job.llmStart ||= performance.now())) / 1000 || 1);
      detail.textContent = `${evt.tokens} tokens${rate > 1 && evt.tokens > 20 ? ` · ${Math.round(rate)} tok/s` : ''}`;
      fill.style.width = `${Math.min(96, (evt.tokens / 900) * 100)}%`;
    } else {
      bar.classList.add('indeterminate');
      detail.textContent = evt.status === 'Analyzing call' ? 'Reading transcript' : evt.status;
    }
    if (evt.partial) {
      job.el.draftCard.hidden = false;
      const summary = partialString(evt.partial, 'summary');
      if (summary) job.el.draft.textContent = summary;
      const keys = [...evt.partial.matchAll(/"(\w+)"\s*:/g)].map((m) => m[1]).filter((k) => SECTION_LABELS[k]);
      const section = keys[keys.length - 1];
      if (section) job.el.draftSection.textContent = `writing ${SECTION_LABELS[section]}`;
    }
  }
}
api.onProgress(onProgress);

async function startAnalysis(filePath) {
  if (currentJob) return toast('An analysis is already running');
  if (engineState?.problems?.length) return toast('Finish setup first');
  const job = { id: crypto.randomUUID(), filePath, name: basename(filePath), startedAt: performance.now() };
  currentJob = job;
  renderProgress(job);
  show('progress', job.name);
  try {
    const record = await api.analyze(job.id, filePath);
    finishJob(job);
    await loadHistory();
    renderResult(record);
    setActiveHistory(record.id);
  } catch (err) {
    finishJob(job);
    const message = cleanError(err);
    if (/cancel|abort/i.test(message)) {
      show('upload');
      toast('Analysis cancelled');
      return;
    }
    $('.btn', $('#view-progress .file-head')).remove();
    job.el.body.append(h('div', { class: 'error-card' },
      h('h3', null, 'Analysis failed'),
      h('pre', null, message),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary', onclick: () => startAnalysis(filePath) }, 'Try again'),
        h('button', { class: 'btn', onclick: () => show('upload') }, 'Back'))));
  }
}

function finishJob(job) {
  clearInterval(job.timer);
  if (currentJob === job) currentJob = null;
}

/* ---------------- results ---------------- */

function card(title, icon, body, { i = 0, count, cls = '' } = {}) {
  return h('div', { class: `card ${cls}`, style: `--i:${i}` },
    h('div', { class: 'card-title', icon }, title, count != null ? h('span', { class: 'count' }, count) : null),
    body);
}

function bulletList(items, kind, marker) {
  if (!items.length) return h('div', { class: 'empty-note' }, 'Nothing noted.');
  return h('ul', { class: `list ${kind}` }, items.map((text, i) => {
    const bullet = h('span', { class: 'bullet' });
    if (marker === 'num') bullet.textContent = i + 1;
    else bullet.innerHTML = ICONS[marker];
    return h('li', { style: `--i:${i}` }, bullet, h('span', { class: 'selectable' }, text));
  }));
}

function probabilityCard(a) {
  const p = a.conversion_probability;
  const r = 70;
  const circumference = 2 * Math.PI * r;
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 168 168');
  const bg = document.createElementNS(svgNS, 'circle');
  const fg = document.createElementNS(svgNS, 'circle');
  for (const c of [bg, fg]) {
    c.setAttribute('cx', 84);
    c.setAttribute('cy', 84);
    c.setAttribute('r', r);
  }
  bg.setAttribute('class', 'ring-bg');
  fg.setAttribute('class', 'ring-fg');
  fg.style.stroke = probColor(p);
  fg.style.strokeDasharray = circumference;
  fg.style.strokeDashoffset = circumference;
  svg.append(bg, fg);

  const num = h('span', null, '0');
  const body = h('div', { class: 'prob' },
    h('div', { class: 'ring-wrap' }, svg,
      h('div', { class: 'ring-val' },
        h('div', { class: 'ring-num' }, num, h('small', null, '%')),
        h('div', { class: 'ring-cap' }, 'conversion'))),
    h('div', { class: 'prob-label', style: `color:${probColor(p)}` }, probLabel(p)),
    h('div', { class: 'prob-break', title: 'Blend of the model\'s estimate (70%) and its skill rubric (30%)' },
      `model ${a.probability_breakdown?.model ?? '–'} · rubric ${a.probability_breakdown?.rubric ?? '–'}`),
    a.probability_reasoning ? h('div', { class: 'prob-reason selectable' }, a.probability_reasoning) : null);

  requestAnimationFrame(() => requestAnimationFrame(() => {
    fg.style.strokeDashoffset = circumference * (1 - p / 100);
    const t0 = performance.now();
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / 1400);
      num.textContent = Math.round(p * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  return card('Conversion probability', 'target', body, { i: 0 });
}

function summaryCard(a) {
  const sentimentCls = { positive: 'good', neutral: '', mixed: 'warn', negative: 'bad' }[a.buyer_sentiment] || '';
  return card('Summary', 'wave', h('div', null,
    h('p', { class: 'summary-text selectable' }, a.summary || 'No summary produced.'),
    h('div', { class: 'tags' },
      h('span', { class: 'tag' }, 'Type ', h('b', null, a.call_type)),
      h('span', { class: `tag ${sentimentCls}` }, `Buyer ${a.buyer_sentiment}`),
      h('span', { class: 'tag' }, `${a.mistakes.length} mistake${a.mistakes.length === 1 ? '' : 's'}`),
      h('span', { class: 'tag' }, `${a.objections.length} objection${a.objections.length === 1 ? '' : 's'}`)),
    a.customer_needs.length
      ? h('div', { class: 'needs' }, h('div', { class: 'sub' }, 'Customer needs'),
        h('div', { class: 'tags' }, a.customer_needs.map((n) => h('span', { class: 'tag selectable' }, n))))
      : null), { i: 1 });
}

function scoresCard(a) {
  const names = { rapport: 'Rapport', discovery: 'Discovery', pitch_clarity: 'Pitch clarity', objection_handling: 'Objection handling', closing: 'Closing' };
  const fills = [];
  const rows = Object.entries(names).map(([key, label]) => {
    const v = a.scores[key] ?? 0;
    const fill = h('i', { style: `background:${v >= 7 ? 'var(--good)' : v >= 4 ? 'var(--warn)' : 'var(--bad)'}` });
    fills.push([fill, v]);
    return h('div', { class: 'score-row' },
      h('span', { class: 'score-name' }, label),
      h('span', { class: 'score-bar' }, fill),
      h('span', { class: 'score-val' }, `${v}/10`));
  });
  requestAnimationFrame(() => requestAnimationFrame(() => fills.forEach(([f, v], i) => {
    f.style.transitionDelay = `${150 + i * 70}ms`;
    f.style.width = `${v * 10}%`;
  })));
  return card('Skill scores', 'spark', h('div', { class: 'scores' }, rows), { i: 2 });
}

function mistakesCard(a) {
  const order = { high: 0, medium: 1, low: 2 };
  const items = [...a.mistakes].sort((x, y) => (order[x.severity] ?? 3) - (order[y.severity] ?? 3));
  const body = items.length
    ? h('div', { class: 'mistakes' }, items.map((m, i) => h('div', { class: `mistake ${m.severity}`, style: `--i:${i}` },
      h('div', { class: 'm-head' }, h('span', { class: 'm-title selectable' }, m.title), h('span', { class: `sev ${m.severity}` }, m.severity)),
      h('div', { class: 'm-grid' },
        h('div', null, h('div', { class: 'm-k' }, 'What happened'), h('div', { class: 'quote selectable' }, m.evidence)),
        h('div', null, h('div', { class: 'm-k' }, 'Better approach'), h('div', { class: 'better selectable' }, m.better_approach))))))
    : h('div', { class: 'empty-note' }, 'No significant mistakes found.');
  return card('Mistakes made', 'alert', body, { i: 4, count: items.length });
}

function objectionsCard(a) {
  const cls = { good: 'good', fair: 'warn', poor: 'bad', 'not addressed': 'bad' };
  const body = a.objections.length
    ? h('div', null, a.objections.map((o) => h('div', { class: 'objection' },
      h('div', { class: 'o-head' }, h('span', { class: 'o-text selectable' }, o.objection), h('span', { class: `tag ${cls[o.handling] || ''}` }, o.handling)),
      h('div', { class: 'o-resp selectable' }, o.suggested_response))))
    : h('div', { class: 'empty-note' }, 'No objections were raised.');
  return card('Objections', 'shield', body, { i: 7, count: a.objections.length });
}

async function transcriptCard(record) {
  const audio = h('audio', { controls: true, preload: 'metadata' });
  const url = record.filePath ? await api.fileUrl(record.filePath) : null;
  if (url) audio.src = url;
  const segEls = record.segments.map((s) => h('div', { class: 'seg' },
    h('button', { class: 'seg-t link', title: 'Play from here', onclick: () => { if (url) { audio.currentTime = s.start; audio.play(); } } }, fmtTime(s.start)),
    h('span', null, s.text)));
  audio.addEventListener('timeupdate', () => {
    const t = audio.currentTime;
    record.segments.forEach((s, i) => segEls[i].classList.toggle('playing', t >= s.start && t < s.end));
  });
  const details = h('details', { class: 'card transcript-card', style: '--i:9' },
    h('summary', null, h('div', { class: 'card-title', icon: 'file' }, 'Transcript', h('span', { class: 'count' }, `${record.segments.length} segments`))),
    url ? audio : h('div', { class: 'empty-note', style: 'margin-bottom:8px' }, 'Original audio file is no longer available.'),
    h('div', { class: 'transcript' }, segEls));
  $('.card-title', details).insertAdjacentHTML('beforeend', ICONS.chev);
  return details;
}

function reportMarkdown(record) {
  const a = record.analysis;
  const list = (xs) => xs.map((x) => `- ${x}`).join('\n') || '- None';
  return [
    `# Call review: ${record.fileName}`,
    `Duration ${fmtTime(record.duration)} · Conversion probability **${a.conversion_probability}%** (${probLabel(a.conversion_probability)})`,
    `\n## Summary\n${a.summary}`,
    `\n## Conversion outlook\n${a.probability_reasoning}`,
    `\n## Skill scores\n${Object.entries(a.scores).map(([k, v]) => `- ${k.replace(/_/g, ' ')}: ${v}/10`).join('\n')}`,
    `\n## Strengths\n${list(a.strengths)}`,
    `\n## Mistakes\n${a.mistakes.map((m) => `- **${m.title}** (${m.severity})\n  - What happened: ${m.evidence}\n  - Better: ${m.better_approach}`).join('\n') || '- None'}`,
    `\n## Objections\n${a.objections.map((o) => `- ${o.objection} — handled ${o.handling}. Try: ${o.suggested_response}`).join('\n') || '- None'}`,
    `\n## Suggestions\n${list(a.suggestions)}`,
    `\n## Recommendations for the rep\n${list(a.recommendations)}`,
    `\n## Next steps\n${list(a.next_steps)}`,
  ].join('\n');
}

async function renderResult(record) {
  const a = record.analysis;
  const s = record.stats || {};
  const view = $('#view-result');
  const perf = h('div', { class: 'perf' },
    s.duration ? h('span', null, 'audio ', h('b', null, fmtTime(s.duration))) : null,
    s.asrMs ? h('span', null, 'transcription ', h('b', null, `${(s.asrMs / 1000).toFixed(1)}s`), ` (${(s.duration / (s.asrMs / 1000)).toFixed(0)}× realtime)`) : null,
    s.llmMs ? h('span', null, 'analysis ', h('b', null, `${(s.llmMs / 1000).toFixed(1)}s`)) : null,
    s.outputTps ? h('span', null, 'generation ', h('b', null, `${s.outputTps} tok/s`)) : null,
    s.totalMs ? h('span', null, 'total ', h('b', null, `${(s.totalMs / 1000).toFixed(1)}s`)) : null,
    h('span', null, 'network ', h('b', null, '0 bytes')));

  view.replaceChildren(h('div', { class: 'result' },
    h('div', { class: 'result-head' },
      h('div', { class: 'grow' },
        h('h2', { class: 'result-title', title: record.fileName }, record.fileName),
        h('div', { class: 'result-meta' },
          h('span', null, fmtTime(record.duration)), h('span', null, '·'),
          h('span', null, new Date(record.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })))),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', icon: 'copy', onclick: async () => { await api.copy(reportMarkdown(record)); toast('Report copied as Markdown'); } }, 'Copy'),
        h('button', {
          class: 'btn', icon: 'download',
          onclick: async (e) => {
            const btn = e.currentTarget;
            const label = btn.lastChild;
            btn.disabled = true;
            btn.classList.add('busy');
            label.textContent = 'Exporting…';
            try {
              const saved = await api.exportPdf(record.id);
              if (saved) toast(`Saved ${basename(saved)}`, { label: 'Show in Finder', run: () => api.reveal(saved) });
            } catch (err) {
              toast(`Export failed: ${cleanError(err)}`);
            } finally {
              btn.disabled = false;
              btn.classList.remove('busy');
              label.textContent = 'Export PDF';
            }
          },
        }, 'Export PDF'),
        h('button', { class: 'btn btn-primary', onclick: () => show('upload') }, 'Analyze another'))),
    h('div', { class: 'grid g-hero' }, probabilityCard(a), summaryCard(a)),
    h('div', { class: 'grid g-2' }, scoresCard(a), card('What went well', 'check', bulletList(a.strengths, 'good', 'check'), { i: 3, count: a.strengths.length })),
    h('div', { class: 'grid' }, mistakesCard(a)),
    h('div', { class: 'grid g-2' },
      card('Suggestions for this call', 'spark', bulletList(a.suggestions, 'accent', 'arrow'), { i: 5, count: a.suggestions.length }),
      card('Recommendations for the rep', 'target', bulletList(a.recommendations, 'accent', 'num'), { i: 6, count: a.recommendations.length })),
    h('div', { class: 'grid g-2' }, objectionsCard(a), card('Next steps', 'arrow', bulletList(a.next_steps, 'plain', 'num'), { i: 8, count: a.next_steps.length })),
    h('div', { class: 'grid' }, await transcriptCard(record)),
    perf));
  show('result', record.fileName);
}

/* ---------------- boot ---------------- */

api.onEngineState(renderEngineStatus);
api.engineStatus().then(renderEngineStatus);
loadHistory();
loadSamples();
