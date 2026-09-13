const fs = require('fs');

// Qwen3-ASR prefixes output with "language English<asr_text>"; strip it.
function cleanAsrText(raw) {
  if (!raw) return '';
  let text = raw;
  const tag = text.lastIndexOf('<asr_text>');
  if (tag !== -1) {
    const prefix = text.slice(0, tag);
    if (/language\s+none/i.test(prefix)) return '';
    text = text.slice(tag + '<asr_text>'.length);
  } else {
    text = text.replace(/^\s*language\s+\w+\s*/i, '');
  }
  text = text.replace(/<\/?asr_text>/g, '').replace(/\s+/g, ' ').trim();
  return collapseRepeats(text);
}

// Guard against the decoder looping on noise: "thank you thank you thank you ...".
function collapseRepeats(text) {
  return text.replace(/(\b(?:\S+\s+){0,5}?\S+\b)(?:[\s,.]+\1\b){3,}/gi, '$1');
}

async function transcribeChunk(server, chunk, { signal } = {}) {
  const data = (await fs.promises.readFile(chunk.file)).toString('base64');
  const seconds = chunk.end - chunk.start;
  const res = await fetch(`${server.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({
      messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data, format: 'wav' } }] }],
      temperature: 0,
      max_tokens: Math.round(60 + seconds * 9),
      cache_prompt: false,
    }),
  });
  if (!res.ok) throw new Error(`Speech engine error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return {
    text: cleanAsrText(json.choices?.[0]?.message?.content),
    tokens: json.usage?.completion_tokens || 0,
  };
}

async function transcribe(server, chunks, { signal, onChunk } = {}) {
  const segments = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const { text } = await transcribeChunk(server, chunk, { signal });
    const segment = { start: chunk.start, end: chunk.end, text };
    if (text) segments.push(segment);
    onChunk?.(i + 1, chunks.length, segment);
  }
  return segments;
}

module.exports = { transcribe, cleanAsrText };
