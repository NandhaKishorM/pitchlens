// How the call *sounded*, with no words involved: a log-mel spectrogram plus
// prosody (pitch, loudness, pace, pauses, periodicity) turned into energy,
// warmth and tension readings.
//
// This path never looks at the transcript, so it still says something useful
// when speech recognition struggles — and it hears things text cannot carry:
// a monotone pitch, a rushed pace, a strained voice, long dead air.
//
// Everything is hand-written DSP with no dependencies, in the same spirit as
// the rest of src/core. The scores are heuristics over fixed reference ranges
// (documented at each weight), not a trained emotion classifier: treat them as
// coaching signals, like the conversion probability.
const fs = require('fs');
const { abortError } = require('./proc');

// 64 ms window / 16 ms hop. The window is long on purpose: autocorrelation
// needs three periods of a 60 Hz voice (50 ms) to lock onto a pitch.
const FRAME = 1024;
const HOP = 256;
const MEL_BANDS = 40;
const F0_MIN = 60;
const F0_MAX = 400;
const MIN_PAUSE_S = 0.25;
// Columns kept in the spectrogram handed to the UI (the full matrix is far too
// large to store in a history record).
const SPECTROGRAM_COLUMNS = 512;

/* ---------------- wav ---------------- */

// prepareAudio() always hands us 16 kHz mono pcm_s16le, so this only has to
// walk the RIFF chunks and scale the samples.
function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Voice analysis expects a WAV file');
  }
  let sampleRate = 16000;
  let channels = 1;
  let bits = 16;
  let data = null;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2) || 1;
      sampleRate = buf.readUInt32LE(body + 4) || 16000;
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length));
    }
    pos = body + size + (size % 2); // chunks are word-aligned
  }
  if (!data) throw new Error('WAV file has no audio data');
  if (bits !== 16) throw new Error(`Unsupported WAV bit depth: ${bits}`);

  const count = Math.floor(data.length / 2 / channels);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += data.readInt16LE((i * channels + c) * 2);
    samples[i] = sum / channels / 32768;
  }
  return { samples, sampleRate };
}

/* ---------------- fft ---------------- */

// Iterative radix-2 Cooley-Tukey with precomputed tables, so a 5 minute call
// (≈19k frames) costs two transforms per frame and still runs in about a second.
class FFT {
  constructor(n) {
    this.n = n;
    this.levels = Math.log2(n);
    if (!Number.isInteger(this.levels)) throw new Error('FFT size must be a power of two');
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < this.levels; b++) r = (r << 1) | ((i >>> b) & 1);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / n);
    }
  }

  // In place. The only thing we invert is a real, symmetric power spectrum,
  // whose inverse transform equals the forward one up to a factor of n — so a
  // single direction is enough.
  transform(re, im) {
    const { n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * cos[k] - im[l] * sin[k];
          const tim = re[l] * sin[k] + im[l] * cos[k];
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  }
}

/* ---------------- mel ---------------- */

// HTK mel scale: simple, and the exact curve does not matter for a heatmap and
// for band ratios.
const hzToMel = (hz) => 2595 * Math.log10(1 + hz / 700);
const melToHz = (mel) => 700 * (10 ** (mel / 2595) - 1);

// Triangular filters over the power spectrum, area-normalised so the loud low
// bands of a voice do not swamp everything above them. Each filter is stored
// as the sparse list of bins it actually touches.
function melFilterbank(bands, fftSize, sampleRate, fMin = 50, fMax = 7600) {
  const bins = fftSize / 2 + 1;
  const lo = hzToMel(fMin);
  const hi = hzToMel(Math.min(fMax, sampleRate / 2));
  const edges = [];
  for (let i = 0; i < bands + 2; i++) edges.push(melToHz(lo + ((hi - lo) * i) / (bands + 1)));

  const filters = [];
  for (let b = 0; b < bands; b++) {
    const [f0, f1, f2] = [edges[b], edges[b + 1], edges[b + 2]];
    const weights = [];
    for (let k = 0; k < bins; k++) {
      const f = (k * sampleRate) / fftSize;
      let w = 0;
      if (f >= f0 && f <= f1) w = (f - f0) / (f1 - f0 || 1);
      else if (f > f1 && f <= f2) w = (f2 - f) / (f2 - f1 || 1);
      if (w > 0) weights.push(k, (2 * w) / (f2 - f0));
    }
    filters.push(Float64Array.from(weights));
  }
  return filters;
}

/* ---------------- per-frame analysis ---------------- */

const yieldToLoop = () => new Promise((r) => setImmediate(r));

// One pass over the audio producing, per frame: the log-mel column, loudness in
// dBFS, pitch with its confidence, and two spectral shape measures.
async function frameAnalysis(samples, sampleRate, { signal, onProgress } = {}) {
  const fft = new FFT(FRAME);
  const filters = melFilterbank(MEL_BANDS, FRAME, sampleRate);
  const bins = FRAME / 2 + 1;

  // Hann window, and the lag range that F0_MIN..F0_MAX maps to.
  const window = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));
  const minLag = Math.floor(sampleRate / F0_MAX);
  const maxLag = Math.min(Math.ceil(sampleRate / F0_MIN), FRAME >> 1);

  // Band edges for the spectral balance measure (vocal effort shows up as
  // energy moving from the low band into 1–4 kHz).
  const binOf = (hz) => Math.min(bins - 1, Math.round((hz * FRAME) / sampleRate));
  const [lowA, lowB, highA, highB] = [binOf(80), binOf(1000), binOf(1000), binOf(4000)];

  const count = samples.length >= FRAME ? Math.floor((samples.length - FRAME) / HOP) + 1 : 0;
  const mel = new Float32Array(count * MEL_BANDS);
  const db = new Float32Array(count);
  const f0 = new Float32Array(count);
  const conf = new Float32Array(count);
  const centroid = new Float32Array(count);
  const highShare = new Float32Array(count);

  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  const power = new Float64Array(bins);
  const acfRe = new Float64Array(FRAME);
  const acfIm = new Float64Array(FRAME);

  for (let t = 0; t < count; t++) {
    const offset = t * HOP;
    let sumSquares = 0;
    for (let i = 0; i < FRAME; i++) {
      const s = samples[offset + i];
      sumSquares += s * s;
      re[i] = s * window[i];
      im[i] = 0;
    }
    db[t] = 10 * Math.log10(sumSquares / FRAME + 1e-12);

    fft.transform(re, im);
    for (let k = 0; k < bins; k++) power[k] = re[k] * re[k] + im[k] * im[k];

    // Log-mel column.
    for (let b = 0; b < MEL_BANDS; b++) {
      const w = filters[b];
      let sum = 0;
      for (let i = 0; i < w.length; i += 2) sum += power[w[i]] * w[i + 1];
      mel[t * MEL_BANDS + b] = 10 * Math.log10(sum + 1e-10);
    }

    // Spectral centroid and the 1–4 kHz share of 80 Hz–4 kHz energy.
    let weighted = 0;
    let total = 0;
    for (let k = 1; k < bins; k++) {
      weighted += ((k * sampleRate) / FRAME) * power[k];
      total += power[k];
    }
    centroid[t] = total > 0 ? weighted / total : 0;
    let low = 0;
    let high = 0;
    for (let k = lowA; k < lowB; k++) low += power[k];
    for (let k = highA; k < highB; k++) high += power[k];
    highShare[t] = low + high > 0 ? high / (low + high) : 0;

    // Pitch: autocorrelation by inverse transform of the power spectrum, which
    // is nearly free now that we have the spectrum. The spectrum is real and
    // symmetric, so mirror it into a full-length buffer first.
    for (let k = 0; k < FRAME; k++) {
      acfRe[k] = power[k <= FRAME / 2 ? k : FRAME - k];
      acfIm[k] = 0;
    }
    fft.transform(acfRe, acfIm);
    const energy0 = acfRe[0];
    let bestLag = 0;
    let bestValue = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (acfRe[lag] > bestValue) {
        bestValue = acfRe[lag];
        bestLag = lag;
      }
    }
    if (bestLag > minLag && bestLag < maxLag && energy0 > 0) {
      // Parabolic interpolation around the peak for sub-sample precision.
      const [a, b, c] = [acfRe[bestLag - 1], acfRe[bestLag], acfRe[bestLag + 1]];
      const denom = a - 2 * b + c;
      const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
      f0[t] = sampleRate / (bestLag + Math.max(-1, Math.min(1, shift)));
      conf[t] = bestValue / energy0;
    }

    if ((t & 1023) === 0) {
      if (signal?.aborted) throw abortError();
      onProgress?.(t, count);
      await yieldToLoop(); // keep the UI and the ASR stream responsive
    }
  }
  onProgress?.(count, count);
  const clean = smoothPitch(f0, conf);
  return { count, mel, db, f0: clean.f0, conf: clean.conf, centroid, highShare, sampleRate, hopS: HOP / sampleRate };
}

/* ---------------- small stats helpers ---------------- */

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const std = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
};
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
const median = (xs) => percentile([...xs].sort((a, b) => a - b), 0.5);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
// Maps a measurement onto 0..1 against a hand-set reference range.
const norm = (v, lo, hi) => clamp01((v - lo) / (hi - lo));
const round = (v, digits = 1) => +(+v).toFixed(digits);
const semitones = (hz, ref) => 12 * Math.log2(hz / ref);

/* ---------------- pitch track cleanup ---------------- */

// A per-frame autocorrelation sometimes locks onto the first harmonic instead
// of the fundamental, which shows up as a lone frame an octave off and wrecks
// every pitch statistic downstream. Compare each frame with its neighbours,
// prefer whichever octave of its own estimate fits them, and drop the frame
// when none does. Real values are kept, so genuine inflection survives.
function smoothPitch(f0, conf) {
  const out = Float32Array.from(f0);
  const kept = Float32Array.from(conf);
  const w = 2; // ±2 frames ≈ ±32 ms
  const plausible = (i) => conf[i] > VOICED_CONF && f0[i] >= F0_MIN && f0[i] <= F0_MAX;
  for (let i = 0; i < f0.length; i++) {
    if (!plausible(i)) continue;
    const near = [];
    for (let j = Math.max(0, i - w); j <= Math.min(f0.length - 1, i + w); j++) if (plausible(j)) near.push(f0[j]);
    if (near.length < 3) continue;
    const m = median(near);
    let best = f0[i];
    for (const candidate of [f0[i] / 2, f0[i] * 2]) {
      if (candidate < F0_MIN || candidate > F0_MAX) continue;
      if (Math.abs(semitones(candidate, m)) < Math.abs(semitones(best, m))) best = candidate;
    }
    if (Math.abs(semitones(best, m)) > 7) kept[i] = 0;
    else out[i] = best;
  }
  return { f0: out, conf: kept };
}

/* ---------------- speech / silence ---------------- */

// Adaptive threshold: the quietest decile of the call is treated as the noise
// floor, and anything well above it (but not absurdly below the peak) is speech.
function detectSpeech(db) {
  const sorted = [...db].sort((a, b) => a - b);
  const floor = percentile(sorted, 0.1);
  const peak = percentile(sorted, 0.95);
  const threshold = Math.max(floor + 8, peak - 35);
  const speech = new Uint8Array(db.length);
  for (let i = 0; i < db.length; i++) speech[i] = db[i] > threshold ? 1 : 0;
  // Fill single-frame gaps so one quiet frame mid-word is not a pause.
  for (let i = 1; i < speech.length - 1; i++) if (!speech[i] && speech[i - 1] && speech[i + 1]) speech[i] = 1;
  return { speech, threshold, floor, peak };
}

// Runs of speech separated by at least MIN_PAUSE_S of silence.
function findUtterances(speech, hopS, minDurationS = 0.35) {
  const gapFrames = Math.round(MIN_PAUSE_S / hopS);
  const runs = [];
  let start = -1;
  let silence = 0;
  for (let i = 0; i < speech.length; i++) {
    if (speech[i]) {
      if (start === -1) start = i;
      silence = 0;
    } else if (start !== -1 && ++silence >= gapFrames) {
      runs.push([start, i - silence + 1]);
      start = -1;
    }
  }
  if (start !== -1) runs.push([start, speech.length]);
  return runs.filter(([a, b]) => (b - a) * hopS >= minDurationS);
}

function findPauses(speech, hopS) {
  const minFrames = Math.round(MIN_PAUSE_S / hopS);
  const first = speech.indexOf(1);
  const last = speech.lastIndexOf(1);
  if (first === -1) return [];
  const pauses = [];
  let run = 0;
  for (let i = first; i <= last; i++) {
    if (!speech[i]) run++;
    else {
      if (run >= minFrames) pauses.push({ start: (i - run) * hopS, seconds: run * hopS });
      run = 0;
    }
  }
  return pauses;
}

// Syllable-rate proxy: peaks in the smoothed loudness envelope. Not a phonetic
// count, but it tracks "rushed" versus "measured" well enough to coach on.
function syllableRate(db, speech, hopS) {
  const smooth = new Float32Array(db.length);
  const w = 2;
  for (let i = 0; i < db.length; i++) {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(db.length - 1, i + w); j++, n++) sum += db[j];
    smooth[i] = sum / n;
  }
  let peaks = 0;
  let speechFrames = 0;
  for (let i = 1; i < smooth.length - 1; i++) {
    if (speech[i]) speechFrames++;
    if (!speech[i] || smooth[i] <= smooth[i - 1] || smooth[i] < smooth[i + 1]) continue;
    // Require a real dip on at least one side so plateaus do not count.
    let dip = 0;
    for (let j = i - 1; j >= Math.max(0, i - 8); j--) dip = Math.max(dip, smooth[i] - smooth[j]);
    if (dip >= 3) peaks++;
  }
  const seconds = speechFrames * hopS;
  return seconds > 0.5 ? peaks / seconds : 0;
}

/* ---------------- features ---------------- */

// 0.35 keeps hum and room noise out of the pitch track.
const VOICED_CONF = 0.35;

// Aggregates the frame data over a frame range (or the whole call).
//   `ref`  — context for the whole recording: a baseline pitch, so a window is
//            judged against the speaker's own median rather than an absolute Hz
//            value, and the noise floor, so loudness can be measured relative
//            to this recording instead of in absolute dBFS (how loud a call was
//            recorded says nothing about how loudly anyone spoke).
//   `runs` — utterance frame ranges. Pitch spread and strain are measured
//            *inside* each utterance and then pooled, because a global spread
//            over a two-person call mostly measures the gap between the two
//            speakers, not how expressive either of them was.
function featuresOf(fa, speech, range, ref, runs) {
  const [from, to] = range || [0, fa.count];
  const { db, f0, conf, centroid, highShare, hopS } = fa;
  const isVoiced = (i) => speech[i] && conf[i] > VOICED_CONF && f0[i] >= F0_MIN && f0[i] <= F0_MAX;

  const voicedF0 = [];
  const voicedDb = [];
  const speechDb = [];
  const voicedIdx = [];
  let speechFrames = 0;
  for (let i = from; i < to; i++) {
    if (!speech[i]) continue;
    speechFrames++;
    speechDb.push(db[i]);
    if (isVoiced(i)) {
      voicedF0.push(f0[i]);
      voicedDb.push(db[i]);
      voicedIdx.push(i);
    }
  }
  const frames = Math.max(1, to - from);
  const seconds = frames * hopS;
  const sortedF0 = [...voicedF0].sort((a, b) => a - b);
  const medianF0 = percentile(sortedF0, 0.5) || 0;

  // Semitone deviations from each utterance's own median pitch: how much the
  // voice moved while speaking, with the speaker's register divided out.
  const spans = (runs?.length ? runs : [[from, to]])
    .map(([a, b]) => [Math.max(a, from), Math.min(b, to)])
    .filter(([a, b]) => b - a > 1);
  const devSt = [];
  for (const [a, b] of spans) {
    const hz = [];
    for (let i = a; i < b; i++) if (isVoiced(i)) hz.push(f0[i]);
    if (hz.length < 4) continue;
    const center = median(hz);
    for (const v of hz) devSt.push(semitones(v, center));
  }
  const sortedDev = [...devSt].sort((a, b) => a - b);
  const pitchVariability = devSt.length > 8 ? (percentile(sortedDev, 0.9) - percentile(sortedDev, 0.1)) / 2 : 0;
  // Upward excursions inside a phrase: pushing, emphasising, or straining.
  const strainedShare = devSt.length > 8 ? devSt.filter((v) => v > 2.5).length / devSt.length : 0;

  // Frame-to-frame instability within voiced runs. At a 16 ms hop this is not
  // cycle-to-cycle jitter/shimmer, but it does catch a shaky or strained voice.
  const pitchSteps = [];
  const loudSteps = [];
  for (let i = 1; i < voicedIdx.length; i++) {
    if (voicedIdx[i] - voicedIdx[i - 1] !== 1) continue;
    pitchSteps.push(Math.abs(semitones(voicedF0[i], voicedF0[i - 1])));
    const a = 10 ** (voicedDb[i] / 20);
    const b = 10 ** (voicedDb[i - 1] / 20);
    loudSteps.push(Math.abs(a - b) / ((a + b) / 2));
  }

  const sortedDb = [...speechDb].sort((a, b) => a - b);
  const rangeMean = (arr) => mean(Array.from({ length: to - from }, (_, i) => arr[from + i]));

  return {
    seconds: round(seconds, 2),
    speechRatio: round(speechFrames / frames, 3),
    voicedRatio: round(voicedF0.length / frames, 3),
    loudnessDb: round(mean(speechDb) || -90),
    loudnessAboveFloorDb: round((mean(speechDb) || -90) - (ref?.floorDb ?? -60)),
    loudnessRangeDb: round(sortedDb.length ? percentile(sortedDb, 0.9) - percentile(sortedDb, 0.1) : 0),
    loudnessVarDb: round(std(speechDb)),
    medianF0: Math.round(medianF0),
    f0RangeHz: sortedF0.length ? [Math.round(percentile(sortedF0, 0.1)), Math.round(percentile(sortedF0, 0.9))] : [0, 0],
    // Relative to `ref` when given, so the UI can say "above their own baseline".
    relativeF0St: ref?.medianF0 && medianF0 ? round(semitones(medianF0, ref.medianF0), 2) : 0,
    pitchVariability: round(pitchVariability, 2),
    pitchInstability: round(mean(pitchSteps), 3),
    loudnessInstability: round(mean(loudSteps) * 100),
    periodicity: round(mean(voicedIdx.map((i) => conf[i])), 3),
    highBandShare: round(rangeMean(highShare), 3),
    centroidHz: Math.round(rangeMean(centroid)),
    strainedShare: round(strainedShare, 3),
    voicedFrames: voicedF0.length,
  };
}

/* ---------------- scoring ---------------- */

// Three readings, each a weighted blend of normalised features. The reference
// ranges come from what a phone call actually looks like (−34..−16 dBFS of
// speech, 2–5 syllables per second, half a semitone of spread when monotone and
// 5 when animated); they are deliberate guesses, not fitted parameters.
function scoreOf(f, rate) {
  const energy =
    0.30 * norm(f.pitchVariability, 0.6, 4.5) +
    0.25 * norm(rate, 2.0, 5.0) +
    0.25 * norm(f.loudnessAboveFloorDb, 12, 34) +
    0.20 * norm(f.loudnessVarDb, 2.5, 9);

  // "Warmth" rather than valence: a steady, expressive, unhurried voice with
  // few dead spots. Audio alone cannot tell happy from polite, so the wording
  // stays modest.
  const warmth =
    0.34 * norm(f.pitchVariability, 0.6, 4.0) +
    0.24 * (1 - norm(f.pitchInstability, 0.25, 1.2)) +
    0.24 * (1 - norm(1 - f.speechRatio, 0.08, 0.45)) +
    0.18 * norm(f.periodicity, 0.35, 0.72);

  const tension =
    0.28 * norm(f.pitchInstability, 0.25, 1.2) +
    0.24 * norm(f.loudnessInstability, 10, 35) +
    0.22 * norm(f.strainedShare, 0.04, 0.3) +
    0.14 * norm(rate, 3.5, 6.0) +
    0.12 * (1 - norm(f.periodicity, 0.3, 0.7));

  return {
    energy: Math.round(energy * 100),
    warmth: Math.round(warmth * 100),
    tension: Math.round(tension * 100),
  };
}

// Quadrant of energy × warmth, with tension overriding when it dominates. The
// bands leave a wide middle on purpose: mid scores should land on the honest
// "nothing stands out" label rather than flip between two confident ones.
function toneLabel(s) {
  if (s.tension >= 62 && s.energy >= 45) return { label: 'Tense and pushed', detail: 'Strained, uneven delivery — effortful rather than relaxed.' };
  if (s.energy >= 58 && s.warmth >= 58) return { label: 'Warm and animated', detail: 'Lively pitch movement and steady loudness — engaged delivery.' };
  if (s.energy >= 58 && s.warmth < 42) return { label: 'Forceful', detail: 'High energy with little warmth — assertive, and easy to hear as pressure.' };
  if (s.energy <= 38 && s.warmth <= 42) return { label: 'Flat and disengaged', detail: 'Monotone and quiet, with long gaps — the voice is not carrying the pitch.' };
  if (s.energy <= 42) return { label: 'Calm and measured', detail: 'Low-key but steady — composed rather than disengaged.' };
  return { label: 'Engaged and even', detail: 'Moderate energy and pitch movement throughout — nothing stands out either way.' };
}

// How much to trust any of this: short calls and barely-voiced audio get a low
// mark, which the UI shows next to the label.
function confidenceOf(f, durationS) {
  const level = 0.5 * norm(durationS, 20, 120) + 0.3 * norm(f.voicedFrames * (HOP / 16000), 5, 60) + 0.2 * norm(f.periodicity, 0.3, 0.6);
  return level >= 0.66 ? 'high' : level >= 0.38 ? 'medium' : 'low';
}

/* ---------------- timeline, moments, voices ---------------- */

// 8–40 equal windows across the call, each scored on its own so the UI can show
// where the tone changed.
function buildTimeline(fa, speech, utterances, rateRef, ref, durationS) {
  const windows = Math.max(6, Math.min(40, Math.round(durationS / 10)));
  const size = Math.max(1, Math.floor(fa.count / windows));
  const out = [];
  for (let w = 0; w < windows; w++) {
    const from = w * size;
    const to = w === windows - 1 ? fa.count : (w + 1) * size;
    if (to <= from) continue;
    const f = featuresOf(fa, speech, [from, to], ref, utterances);
    const silent = f.speechRatio < 0.12 || f.voicedFrames < 8;
    const rate = silent ? rateRef : syllableRate(fa.db.subarray(from, to), speech.subarray(from, to), fa.hopS);
    out.push({
      start: round(from * fa.hopS, 2),
      end: round(to * fa.hopS, 2),
      silent,
      speechRatio: f.speechRatio,
      loudnessDb: f.loudnessDb,
      f0: f.medianF0,
      ...(silent ? { energy: 0, warmth: 0, tension: 0 } : scoreOf(f, rate)),
    });
  }
  return out;
}

// The windows worth jumping to: the most tense, the flattest, the liveliest.
function pickMoments(timeline) {
  const live = timeline.filter((w) => !w.silent);
  if (live.length < 3) return [];
  const moments = [];
  const push = (kind, note, w) => w && moments.push({ kind, note, start: w.start, end: w.end });
  const byTension = [...live].sort((a, b) => b.tension - a.tension);
  const byEnergy = [...live].sort((a, b) => a.energy - b.energy);
  if (byTension[0].tension >= 55) push('tension', 'Most strained stretch', byTension[0]);
  if (byEnergy[0].energy <= 35) push('flat', 'Flattest stretch', byEnergy[0]);
  const best = byEnergy[byEnergy.length - 1];
  if (best.energy >= 55 && best !== byTension[0]) push('engaged', 'Liveliest stretch', best);
  return moments;
}

// Two voices, split by pitch alone (1-D k-means over per-utterance median F0).
// This is the only way to get a talk-share out of audio with no diarisation,
// but it cannot know which group is the rep — so the UI names them by pitch and
// says it is an estimate. Declines (and says why) unless the split is clear:
// one person on a quiet line and two people of similar pitch look alike here,
// and a wrong talk-share is worse than none.
function groupVoices(fa, speech, utterances, ref) {
  const declined = (note) => ({ voices: null, note });
  if (utterances.length < 6) return declined('Too few separate stretches of speech to compare voices.');
  const items = utterances
    .map(([a, b]) => ({ a, b, f: featuresOf(fa, speech, [a, b], ref, [[a, b]]) }))
    .filter((u) => u.f.medianF0 > 0 && u.f.voicedFrames >= 6);
  if (items.length < 6) return declined('Too little clearly voiced speech to compare voices.');

  const pitches = items.map((u) => u.f.medianF0).sort((x, y) => x - y);
  let centers = [percentile(pitches, 0.2), percentile(pitches, 0.8)];
  const apart = (c) => round(semitones(c[1], c[0]), 1);
  if (apart(centers) < 2.5) return declined(`Only one pitch range in the call (spread ${apart(centers)} semitones) — one speaker, or two who sound alike.`);
  let assign = items.map(() => 0);
  for (let iter = 0; iter < 20; iter++) {
    assign = items.map((u) => (Math.abs(semitones(u.f.medianF0, centers[0])) <= Math.abs(semitones(u.f.medianF0, centers[1])) ? 0 : 1));
    const next = [0, 1].map((g) => {
      const group = items.filter((_, i) => assign[i] === g).map((u) => u.f.medianF0);
      return group.length ? median(group) : centers[g];
    });
    if (Math.abs(next[0] - centers[0]) < 0.5 && Math.abs(next[1] - centers[1]) < 0.5) {
      centers = next;
      break;
    }
    centers = next;
  }

  // Only report two voices if both are substantial and clearly apart.
  const totals = [0, 1].map((g) => items.filter((_, i) => assign[i] === g).reduce((sum, u) => sum + (u.b - u.a) * fa.hopS, 0));
  const total = totals[0] + totals[1];
  const share = totals.map((t) => t / (total || 1));
  if (apart(centers) < 3) return declined(`The two pitch groups are only ${apart(centers)} semitones apart — too close to call them different voices.`);
  if (Math.min(...share) < 0.15) return declined(`One pitch range covers ${Math.round(Math.max(...share) * 100)}% of the speech — most likely a single voice.`);

  const voices = [0, 1].map((g) => {
    // Score each group over just its own frames.
    const own = new Uint8Array(speech.length);
    for (let i = 0; i < items.length; i++) {
      if (assign[i] !== g) continue;
      for (let j = items[i].a; j < items[i].b; j++) own[j] = speech[j];
    }
    const mine = items.filter((_, i) => assign[i] === g).map((u) => [u.a, u.b]);
    const f = featuresOf(fa, own, [0, fa.count], { ...ref, medianF0: centers[g] }, mine);
    const rate = syllableRate(fa.db, own, fa.hopS);
    const scores = scoreOf(f, rate);
    return {
      id: g === 0 ? 'lower' : 'higher',
      medianF0: Math.round(centers[g]),
      talkShare: round(share[g], 3),
      seconds: round(totals[g], 1),
      rate: round(rate, 2),
      ...scores,
      ...toneLabel(scores),
    };
  });
  return { voices, note: `Split by pitch, ${apart(centers)} semitones apart.` };
}

/* ---------------- spectrogram for the UI ---------------- */

// The full matrix is ~19k columns for a 5 minute call. Average it down to at
// most SPECTROGRAM_COLUMNS, normalise so the loudest cell is 0 dB, and quantise
// to whole dB in a flat array — small enough to keep in a history record.
function packSpectrogram(fa) {
  const columns = Math.max(1, Math.min(SPECTROGRAM_COLUMNS, fa.count));
  const per = fa.count / columns;
  const values = new Int16Array(columns * MEL_BANDS);
  let max = -Infinity;
  for (let c = 0; c < columns; c++) {
    const from = Math.floor(c * per);
    const to = Math.max(from + 1, Math.floor((c + 1) * per));
    for (let b = 0; b < MEL_BANDS; b++) {
      let sum = 0;
      for (let t = from; t < to; t++) sum += fa.mel[t * MEL_BANDS + b];
      const v = sum / (to - from);
      values[c * MEL_BANDS + b] = v;
      if (v > max) max = v;
    }
  }
  const floorDb = -70;
  const db = new Array(values.length);
  for (let i = 0; i < values.length; i++) db[i] = Math.max(floorDb, Math.round(values[i] - max));
  return { columns, bands: MEL_BANDS, floorDb, db, hopS: round(per * fa.hopS, 4) };
}

/* ---------------- entry point ---------------- */

// Reads the 16 kHz WAV that prepareAudio() already produced and returns
// everything the UI, the PDF and the coaching prompt need.
async function analyzeVoice(wavFile, { signal, onProgress } = {}) {
  const { samples, sampleRate } = readWav(wavFile);
  const durationS = samples.length / sampleRate;
  const fa = await frameAnalysis(samples, sampleRate, { signal, onProgress });
  if (!fa.count) throw new Error('Recording is too short for voice analysis');

  const { speech, threshold, floor } = detectSpeech(fa.db);
  const utterances = findUtterances(speech, fa.hopS);
  const pauses = findPauses(speech, fa.hopS);
  const rate = syllableRate(fa.db, speech, fa.hopS);

  const features = featuresOf(fa, speech, null, { floorDb: floor }, utterances);
  const scores = scoreOf(features, rate);
  const ref = { medianF0: features.medianF0 || 1, floorDb: floor };
  const timeline = buildTimeline(fa, speech, utterances, rate, ref, durationS);

  const pauseSeconds = pauses.reduce((sum, p) => sum + p.seconds, 0);
  const speakingSeconds = (features.speechRatio || 0) * durationS;

  return {
    version: 1,
    durationS: round(durationS, 2),
    frameMs: Math.round((FRAME / sampleRate) * 1000),
    hopMs: Math.round((HOP / sampleRate) * 1000),
    scores,
    ...toneLabel(scores),
    confidence: confidenceOf(features, durationS),
    features: {
      ...features,
      syllableRate: round(rate, 2),
      pauseCount: pauses.length,
      pauseSeconds: round(pauseSeconds, 1),
      longestPauseS: round(Math.max(0, ...pauses.map((p) => p.seconds)), 1),
      silenceRatio: round(1 - (features.speechRatio || 0), 3),
      speakingSeconds: round(speakingSeconds, 1),
      utterances: utterances.length,
      noiseFloorDb: round(floor),
      speechThresholdDb: round(threshold),
    },
    timeline,
    moments: pickMoments(timeline),
    ...(({ voices, note }) => ({ voices, voicesNote: note }))(groupVoices(fa, speech, utterances, ref)),
    spectrogram: packSpectrogram(fa),
  };
}

/* ---------------- prompt text ---------------- */

const paceWord = (r) => (r >= 4.6 ? 'rushed' : r >= 3.6 ? 'brisk' : r >= 2.4 ? 'measured' : 'slow');
const pitchWord = (v) => (v >= 3 ? 'expressive' : v >= 1.6 ? 'moderate' : v >= 0.9 ? 'fairly flat' : 'monotone');

// A compact block for the coaching prompt. The analysis model cannot hear the
// call, so these few lines are the only delivery evidence it gets.
function voiceBrief(voice) {
  if (!voice) return '';
  const f = voice.features;
  const s = voice.scores;
  const fmt = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
  const lines = [
    `- Overall tone: ${voice.label.toLowerCase()} (confidence ${voice.confidence})`,
    `- Vocal energy ${s.energy}/100 · warmth ${s.warmth}/100 · tension ${s.tension}/100`,
    `- Pace ~${f.syllableRate} syllables/s (${paceWord(f.syllableRate)}) · pitch movement ${f.pitchVariability} semitones (${pitchWord(f.pitchVariability)})`,
    `- Loudness ${f.loudnessDb} dBFS, varying ${f.loudnessRangeDb} dB · median pitch ${f.medianF0} Hz`,
    `- Silence ${Math.round(f.silenceRatio * 100)}% of the call · ${f.pauseCount} pauses over ${MIN_PAUSE_S}s, longest ${f.longestPauseS}s`,
  ];
  if (voice.voices) {
    const [low, high] = voice.voices;
    lines.push(
      `- Two voices separated by pitch (estimate, speaker identity unknown): lower voice ${Math.round(low.talkShare * 100)}% of speaking time (${low.label.toLowerCase()}), higher voice ${Math.round(high.talkShare * 100)}% (${high.label.toLowerCase()})`,
    );
  }
  for (const m of voice.moments) lines.push(`- ${m.note}: ${fmt(m.start)}–${fmt(m.end)}`);
  return `VOICE SIGNALS (measured from the audio itself, independent of the words):\n${lines.join('\n')}\nThese describe how the call sounded, not what was said. Use them for delivery coaching; do not treat them as proof of what anyone felt.`;
}

module.exports = {
  analyzeVoice,
  voiceBrief,
  readWav,
  FFT,
  melFilterbank,
  detectSpeech,
  featuresOf,
  scoreOf,
  toneLabel,
  syllableRate,
  MEL_BANDS,
};
