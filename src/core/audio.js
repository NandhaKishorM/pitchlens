const fs = require('fs');
const path = require('path');
const config = require('./config');
const { findBin, run } = require('./proc');

async function probeDuration(file, opts) {
  const { stdout } = await run(findBin('ffprobe'), [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
  ], opts);
  const seconds = parseFloat(stdout.trim());
  if (!Number.isFinite(seconds)) throw new Error('Could not read audio duration — is this an audio file?');
  return seconds;
}

function parseSilences(stderr) {
  const silences = [];
  let start = null;
  for (const line of stderr.split('\n')) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) start = Math.max(0, parseFloat(s[1]));
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (e && start !== null) {
      silences.push({ start, end: parseFloat(e[1]) });
      start = null;
    }
  }
  return silences;
}

// Pick cut points inside pauses so words are not split across chunks.
function planCuts(duration, silences, { target, min, max }) {
  const mids = silences.map((s) => ({ t: (s.start + s.end) / 2, len: s.end - s.start }));
  const cuts = [];
  let last = 0;
  while (duration - last > max) {
    const window = mids.filter((m) => m.t > last + min && m.t <= last + max);
    let cut;
    if (window.length) {
      // Prefer long pauses near the target length.
      cut = window.reduce((best, m) => {
        const score = Math.abs(m.t - (last + target)) - m.len * 8;
        return score < best.score ? { t: m.t, score } : best;
      }, { t: last + target, score: Infinity }).t;
    } else {
      cut = last + target;
    }
    cuts.push(+cut.toFixed(3));
    last = cut;
  }
  return cuts;
}

// Decode any input to 16 kHz mono PCM (detecting pauses in the same pass),
// then split the WAV at pause boundaries.
async function prepareAudio(input, workDir, { signal } = {}) {
  const ffmpeg = findBin('ffmpeg');
  const wav = path.join(workDir, 'full.wav');
  const { stderr } = await run(ffmpeg, [
    '-hide_banner', '-nostats', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000',
    '-af', 'silencedetect=noise=-32dB:d=0.3', '-c:a', 'pcm_s16le', wav,
  ], { signal });

  const duration = await probeDuration(wav, { signal });
  const cuts = planCuts(duration, parseSilences(stderr), config.chunk);
  const pattern = path.join(workDir, 'chunk_%04d.wav');
  const segArgs = cuts.length ? ['-f', 'segment', '-segment_times', cuts.join(','), '-reset_timestamps', '1'] : [];
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-c', 'copy',
    ...(cuts.length ? segArgs : ['-f', 'wav']), cuts.length ? pattern : path.join(workDir, 'chunk_0000.wav'),
  ], { signal });

  const files = fs.readdirSync(workDir).filter((f) => /^chunk_\d+\.wav$/.test(f)).sort();
  const bounds = [0, ...cuts, duration];
  const chunks = files.map((f, i) => ({
    file: path.join(workDir, f),
    start: bounds[i] ?? 0,
    end: bounds[i + 1] ?? duration,
  }));
  // `wav` is the whole call in one piece — the voice analysis reads it directly.
  return { duration, chunks, wav };
}

module.exports = { prepareAudio, probeDuration, planCuts, parseSilences };
