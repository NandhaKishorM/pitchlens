const zlib = require('zlib');
const { BrowserWindow } = require('electron');
const { fmtTime } = require('../core/analyze');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const probColor = (p) => (p >= 60 ? '#16935c' : p >= 35 ? '#b7791f' : '#d14343');
const probLabel = (p) => (p >= 76 ? 'Very likely to convert' : p >= 56 ? 'Likely to convert' : p >= 36 ? 'Uncertain' : p >= 16 ? 'Unlikely to convert' : 'Very unlikely');
const scoreColor = (v) => (v >= 7 ? '#16935c' : v >= 4 ? '#c98a1b' : '#d14343');
const SEVERITY = { high: '#d14343', medium: '#c98a1b', low: '#9aa0aa' };
const SCORE_NAMES = { rapport: 'Rapport', discovery: 'Discovery', pitch_clarity: 'Pitch clarity', objection_handling: 'Objection handling', closing: 'Closing' };

/* ---------------- spectrogram image ---------------- */

// The print page runs with JavaScript disabled, so it cannot draw a canvas:
// the mel spectrogram is encoded here as a PNG and embedded as a data URI.
// Minimal truecolor writer, no filtering — zlib does the compressing.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8 bits per sample
  ihdr[9] = 2; // truecolor RGB
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter type: none
    rgb.copy(raw, y * stride + 1, y * width * 3, (y + 1) * width * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Light-background ramp, so the spectrogram reads on paper. The dark-UI
// equivalent lives in src/renderer/app.js (SPEC_RAMP) — same shape, inverted.
const PRINT_RAMP = [
  [0.0, [255, 255, 255]],
  [0.3, [219, 226, 242]],
  [0.55, [141, 166, 224]],
  [0.75, [77, 104, 214]],
  [0.9, [201, 138, 27]],
  [1.0, [90, 46, 8]],
];

function rampColor(t) {
  for (let i = 1; i < PRINT_RAMP.length; i++) {
    const [p1, c1] = PRINT_RAMP[i];
    if (t > p1 && i !== PRINT_RAMP.length - 1) continue;
    const [p0, c0] = PRINT_RAMP[i - 1];
    const k = Math.min(1, Math.max(0, (t - p0) / (p1 - p0 || 1)));
    return c0.map((v, j) => Math.round(v + (c1[j] - v) * k));
  }
  return PRINT_RAMP[0][1];
}

function spectrogramUri(spec) {
  const span = -spec.floorDb || 70;
  const rgb = Buffer.alloc(spec.columns * spec.bands * 3);
  for (let c = 0; c < spec.columns; c++) {
    for (let b = 0; b < spec.bands; b++) {
      const [r, g, bl] = rampColor((spec.db[c * spec.bands + b] - spec.floorDb) / span);
      // Low frequencies at the bottom; image rows run top-down.
      const i = ((spec.bands - 1 - b) * spec.columns + c) * 3;
      rgb[i] = r;
      rgb[i + 1] = g;
      rgb[i + 2] = bl;
    }
  }
  return `data:image/png;base64,${encodePng(spec.columns, spec.bands, rgb).toString('base64')}`;
}

const paceWord = (r) => (r >= 4.6 ? 'rushed' : r >= 3.6 ? 'brisk' : r >= 2.4 ? 'measured' : 'slow');
const pitchWord = (v) => (v >= 3 ? 'expressive' : v >= 1.6 ? 'moderate' : v >= 0.9 ? 'fairly flat' : 'monotone');

// The whole voice section, or nothing for records analyzed before it existed.
function voiceSection(voice) {
  if (!voice) return '';
  const f = voice.features;
  const sc = voice.scores;
  const total = voice.durationS || 1;
  const toneColor = (w) => (w.silent ? '#e4e6eb' : w.tension >= 60 ? '#d14343' : w.tension >= 42 ? '#c98a1b' : '#16935c');
  const meters = [
    ['Vocal energy', sc.energy, '#4d68d6'],
    ['Warmth', sc.warmth, '#16935c'],
    ['Tension', sc.tension, sc.tension >= 60 ? '#d14343' : '#c98a1b'],
  ];
  const stats = [
    ['Pace', `${f.syllableRate}/s`, paceWord(f.syllableRate)],
    ['Inflection', `${f.pitchVariability} st`, pitchWord(f.pitchVariability)],
    ['Pitch', `${f.medianF0} Hz`, `${f.f0RangeHz[0]}–${f.f0RangeHz[1]} Hz`],
    ['Speech', `${Math.round((1 - f.silenceRatio) * 100)}%`, `${fmtTime(f.speakingSeconds)} spoken`],
    ['Pauses', String(f.pauseCount), `longest ${f.longestPauseS}s`],
    ['Level', `${f.loudnessAboveFloorDb} dB`, 'above floor'],
  ];

  return `
  <section>
    <h2>Voice and delivery — measured from the audio, not the words</h2>
    <div class="box voice-box">
      <div class="v-top">
        <div><b>${esc(voice.label)}</b> — ${esc(voice.detail)}</div>
        <span class="fine">${esc(voice.confidence)} confidence</span>
      </div>
      <div class="specgroup">
        <img class="spec" src="${spectrogramUri(voice.spectrogram)}" alt="Mel spectrogram of the call" />
        <div class="strip">${voice.timeline.map((w) => `<i style="width:${((w.end - w.start) / total) * 100}%;background:${toneColor(w)}"></i>`).join('')}</div>
        <div class="axis">${[0, 0.25, 0.5, 0.75, 1].map((q) => `<span>${fmtTime(total * q)}</span>`).join('')}</div>
      </div>
      <table class="scores">${meters.map(([label, v, color]) =>
        `<tr><td class="name">${label}</td><td><div class="meter"><i style="width:${v}%;background:${color}"></i></div></td><td class="val">${v}</td></tr>`).join('')}</table>
      <div class="vstats">${stats.map(([k, v, n]) =>
        `<div><div class="k">${esc(k)}</div><div class="vv">${esc(v)}</div><div class="fine">${esc(n)}</div></div>`).join('')}</div>
      ${voice.moments.length ? `<p class="reason">${voice.moments.map((m) => `${esc(m.note)}: ${fmtTime(m.start)}–${fmtTime(m.end)}`).join(' · ')}</p>` : ''}
      <div class="sub">Voices, separated by pitch (estimate — which one is the rep is not knowable from audio)</div>
      ${voice.voices
        ? `<table class="vtable">${voice.voices.map((v) => `<tr>
             <td class="name">${v.id === 'lower' ? 'Lower' : 'Higher'} voice · ${v.medianF0} Hz</td>
             <td><div class="meter"><i style="width:${Math.round(v.talkShare * 100)}%;background:#4d68d6"></i></div></td>
             <td class="val">${Math.round(v.talkShare * 100)}%</td>
             <td class="tone">${esc(v.label)}</td></tr>`).join('')}</table>`
        : `<p class="empty">${esc(voice.voicesNote || 'Could not separate two voices.')}</p>`}
      <p class="fine">${voice.spectrogram.bands}-band log-mel spectrogram · ${voice.frameMs} ms frames every ${voice.hopMs} ms · pitch by autocorrelation. Heuristic scores, not a trained emotion model.</p>
    </div>
  </section>`;
}

/* ---------------- report ---------------- */

const list = (items, empty = 'Nothing noted.') =>
  items?.length ? `<ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : `<p class="empty">${empty}</p>`;
const olist = (items, empty = 'Nothing noted.') =>
  items?.length ? `<ol>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : `<p class="empty">${empty}</p>`;

const CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; color: #16181d; font: 10pt/1.5 -apple-system, "SF Pro Text", "Segoe UI", "Helvetica Neue", Arial, sans-serif; -webkit-print-color-adjust: exact; }
  .brand { display: flex; align-items: center; gap: 6pt; font-size: 8pt; font-weight: 650; letter-spacing: .12em; text-transform: uppercase; color: #4d68d6; }
  .brand i { width: 9pt; height: 9pt; border-radius: 3pt; background: #6f8fff; display: inline-block; }
  h1 { font-size: 19pt; letter-spacing: -.02em; margin: 6pt 0 2pt; line-height: 1.2; word-break: break-word; }
  .meta { color: #6b7280; font-size: 9pt; }
  h2 { font-size: 8pt; font-weight: 650; text-transform: uppercase; letter-spacing: .1em; color: #6b7280; margin: 0 0 7pt; break-after: avoid; }
  section { margin-top: 16pt; }
  .box { border: 1px solid #e4e6eb; border-radius: 8pt; padding: 11pt 13pt; break-inside: avoid; }
  .hero { display: grid; grid-template-columns: 150pt 1fr; gap: 12pt; margin-top: 14pt; }
  .prob-num { font-size: 36pt; font-weight: 750; letter-spacing: -.03em; line-height: 1; }
  .prob-num small { font-size: 15pt; color: #6b7280; font-weight: 600; }
  .prob-label { font-weight: 650; margin-top: 4pt; }
  .meter { height: 5pt; background: #eceef2; border-radius: 5pt; overflow: hidden; margin: 8pt 0 6pt; }
  .meter i { display: block; height: 100%; border-radius: 5pt; }
  .fine { color: #8a8f98; font-size: 8pt; font-family: Menlo, Consolas, monospace; }
  .reason { color: #4b5563; font-size: 9pt; margin-top: 7pt; }
  .summary { font-size: 11pt; line-height: 1.6; margin: 0 0 9pt; }
  .tags span { display: inline-block; border: 1px solid #e4e6eb; border-radius: 20pt; padding: 1pt 7pt; font-size: 8.5pt; margin: 0 4pt 4pt 0; color: #374151; }
  .sub { font-size: 7.5pt; text-transform: uppercase; letter-spacing: .1em; color: #8a8f98; margin: 6pt 0 4pt; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 12pt; }
  table.scores { width: 100%; border-collapse: collapse; }
  table.scores td { padding: 3.5pt 0; vertical-align: middle; }
  table.scores td.name { width: 38%; color: #4b5563; }
  table.scores td.val { width: 34pt; text-align: right; font: 600 9pt Menlo, Consolas, monospace; }
  table.scores .meter { margin: 0 8pt; }
  ul, ol { margin: 0; padding-left: 14pt; }
  li { margin-bottom: 4pt; }
  .empty { color: #8a8f98; margin: 0; }
  .mistake { border: 1px solid #e4e6eb; border-left-width: 3pt; border-radius: 6pt; padding: 8pt 11pt; margin-bottom: 7pt; break-inside: avoid; }
  .m-head { display: flex; justify-content: space-between; gap: 10pt; font-weight: 650; margin-bottom: 4pt; }
  .sev { font: 700 7pt Menlo, Consolas, monospace; letter-spacing: .06em; text-transform: uppercase; padding: 1pt 5pt; border-radius: 3pt; color: #fff; white-space: nowrap; align-self: flex-start; }
  .m-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10pt; font-size: 9.5pt; }
  .k { font-size: 7pt; text-transform: uppercase; letter-spacing: .1em; color: #8a8f98; margin-bottom: 2pt; }
  .quote { color: #4b5563; font-style: italic; border-left: 2px solid #e4e6eb; padding-left: 7pt; }
  .objection { padding: 6pt 0; border-bottom: 1px solid #eef0f3; break-inside: avoid; }
  .objection:last-child { border-bottom: 0; }
  .o-head { display: flex; justify-content: space-between; gap: 8pt; font-weight: 600; }
  .o-handling { font-size: 8pt; font-weight: 600; white-space: nowrap; }
  .o-resp { color: #4b5563; font-size: 9.5pt; }
  /* Tall enough that keeping it atomic would leave half a page blank, so this
     one box may break — its parts stay whole. */
  .voice-box { break-inside: auto; }
  .specgroup, .vstats > div, table.vtable tr { break-inside: avoid; }
  .v-top { display: flex; justify-content: space-between; gap: 10pt; align-items: baseline; margin-bottom: 8pt; }
  img.spec { display: block; width: 100%; height: 90pt; border: 1px solid #e4e6eb; border-radius: 5pt; }
  .strip { display: flex; gap: .5pt; margin-top: 3pt; }
  .strip i { display: block; height: 3.5pt; border-radius: 1.5pt; }
  .axis { display: flex; justify-content: space-between; font: 7.5pt Menlo, Consolas, monospace; color: #9ca3af; margin-top: 2pt; }
  .vstats { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6pt; margin-top: 9pt; }
  .vstats > div { border: 1px solid #eef0f3; border-radius: 5pt; padding: 5pt 6pt; }
  .vstats .vv { font: 600 11pt Menlo, Consolas, monospace; margin: 1pt 0; }
  table.vtable { width: 100%; border-collapse: collapse; }
  table.vtable td { padding: 3pt 0; vertical-align: middle; }
  table.vtable td.name { width: 33%; color: #4b5563; }
  table.vtable td.val { width: 28pt; text-align: right; font: 600 9pt Menlo, Consolas, monospace; }
  table.vtable td.tone { width: 30%; padding-left: 10pt; color: #4b5563; font-size: 9pt; }
  table.vtable .meter { margin: 0 8pt; }
  .transcript { break-before: page; }
  .seg { display: grid; grid-template-columns: 34pt 1fr; gap: 8pt; font-size: 9pt; padding: 2.5pt 0; break-inside: avoid; }
  .seg .t { color: #9ca3af; font-family: Menlo, Consolas, monospace; font-size: 8pt; padding-top: 1pt; }
  .perf { margin-top: 14pt; color: #8a8f98; font: 7.5pt Menlo, Consolas, monospace; }
`;

function buildHtml(record, { includeTranscript = true } = {}) {
  const a = record.analysis;
  const p = a.conversion_probability;
  const s = record.stats || {};
  const handlingColor = { good: '#16935c', fair: '#c98a1b', poor: '#d14343', 'not addressed': '#d14343' };
  const order = { high: 0, medium: 1, low: 2 };
  const mistakes = [...a.mistakes].sort((x, y) => (order[x.severity] ?? 3) - (order[y.severity] ?? 3));
  const created = new Date(record.createdAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(record.fileName)} · Call review</title><style>${CSS}</style></head><body>
  <div class="brand"><i></i>Pitchlens · Call review</div>
  <h1>${esc(record.fileName)}</h1>
  <div class="meta">${fmtTime(record.duration)} call · analyzed ${esc(created)} · ${esc(a.call_type)} · buyer ${esc(a.buyer_sentiment)}</div>

  <div class="hero">
    <div class="box">
      <h2>Conversion probability</h2>
      <div class="prob-num" style="color:${probColor(p)}">${p}<small>%</small></div>
      <div class="meter"><i style="width:${p}%;background:${probColor(p)}"></i></div>
      <div class="prob-label" style="color:${probColor(p)}">${probLabel(p)}</div>
      <div class="fine">model ${a.probability_breakdown?.model ?? '–'} · rubric ${a.probability_breakdown?.rubric ?? '–'}</div>
      ${a.probability_reasoning ? `<div class="reason">${esc(a.probability_reasoning)}</div>` : ''}
    </div>
    <div class="box">
      <h2>Summary</h2>
      <p class="summary">${esc(a.summary)}</p>
      <div class="tags"><span>${a.mistakes.length} mistakes</span><span>${a.objections.length} objections</span><span>${a.strengths.length} strengths</span></div>
      ${a.customer_needs.length ? `<div class="sub">Customer needs</div><div class="tags">${a.customer_needs.map((n) => `<span>${esc(n)}</span>`).join('')}</div>` : ''}
    </div>
  </div>

  <section class="two">
    <div class="box">
      <h2>Skill scores</h2>
      <table class="scores">${Object.entries(SCORE_NAMES).map(([k, label]) => {
        const v = a.scores[k] ?? 0;
        return `<tr><td class="name">${label}</td><td><div class="meter"><i style="width:${v * 10}%;background:${scoreColor(v)}"></i></div></td><td class="val">${v}/10</td></tr>`;
      }).join('')}</table>
    </div>
    <div class="box"><h2>What went well</h2>${list(a.strengths)}</div>
  </section>

  ${voiceSection(record.voice)}

  <section>
    <h2>Mistakes made</h2>
    ${mistakes.length ? mistakes.map((m) => `
      <div class="mistake" style="border-left-color:${SEVERITY[m.severity] || SEVERITY.low}">
        <div class="m-head"><span>${esc(m.title)}</span><span class="sev" style="background:${SEVERITY[m.severity] || SEVERITY.low}">${esc(m.severity)}</span></div>
        <div class="m-grid">
          <div><div class="k">What happened</div><div class="quote">${esc(m.evidence)}</div></div>
          <div><div class="k">Better approach</div><div>${esc(m.better_approach)}</div></div>
        </div>
      </div>`).join('') : '<p class="empty">No significant mistakes found.</p>'}
  </section>

  <section class="two">
    <div class="box"><h2>Suggestions for this call</h2>${list(a.suggestions)}</div>
    <div class="box"><h2>Recommendations for the rep</h2>${olist(a.recommendations)}</div>
  </section>

  <section class="two">
    <div class="box">
      <h2>Objections</h2>
      ${a.objections.length ? a.objections.map((o) => `
        <div class="objection">
          <div class="o-head"><span>${esc(o.objection)}</span><span class="o-handling" style="color:${handlingColor[o.handling] || '#6b7280'}">${esc(o.handling)}</span></div>
          <div class="o-resp">${esc(o.suggested_response)}</div>
        </div>`).join('') : '<p class="empty">No objections were raised.</p>'}
    </div>
    <div class="box"><h2>Next steps</h2>${olist(a.next_steps)}</div>
  </section>

  ${includeTranscript && record.segments?.length ? `
  <section class="transcript">
    <h2>Transcript</h2>
    ${record.segments.map((seg) => `<div class="seg"><span class="t">${fmtTime(seg.start)}</span><span>${esc(seg.text)}</span></div>`).join('')}
  </section>` : ''}

  <div class="perf">Generated on-device by Pitchlens · Qwen3-ASR 0.6B + Qwen3.5 2B${s.totalMs ? ` · processed in ${(s.totalMs / 1000).toFixed(1)}s` : ''} · no data left this device</div>
  </body></html>`;
}

// Renders the report in a hidden, script-less window and prints it to PDF.
async function renderPdf(record, opts) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, javascript: false, spellcheck: false },
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildHtml(record, opts))}`);
    return await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0.5, bottom: 0.6, left: 0.55, right: 0.55 },
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: `<div style="width:100%;font-size:7px;color:#9aa0aa;padding:0 40px;display:flex;justify-content:space-between;font-family:-apple-system,'Segoe UI',Helvetica,Arial"><span>Pitchlens · ${esc(record.fileName)}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
    });
  } finally {
    win.destroy();
  }
}

module.exports = { renderPdf, buildHtml };
