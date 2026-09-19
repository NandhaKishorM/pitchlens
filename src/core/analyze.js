const config = require('./config');

const SCORE_KEYS = ['rapport', 'discovery', 'pitch_clarity', 'objection_handling', 'closing'];

// Field order matters for a small model: evidence and reasoning come before the
// probability number, and coaching comes after the diagnosis.
const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    call_type: { type: 'string', enum: ['cold call', 'lead qualification', 'discovery', 'demo', 'follow-up', 'negotiation', 'closing', 'customer support', 'other'] },
    customer_needs: { type: 'array', items: { type: 'string' }, maxItems: 4 },
    buyer_sentiment: { type: 'string', enum: ['positive', 'neutral', 'mixed', 'negative'] },
    strengths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 4 },
    mistakes: {
      type: 'array',
      minItems: 2,
      maxItems: 4,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          evidence: { type: 'string' },
          better_approach: { type: 'string' },
        },
        required: ['title', 'severity', 'evidence', 'better_approach'],
      },
    },
    objections: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        properties: {
          objection: { type: 'string' },
          handling: { type: 'string', enum: ['good', 'fair', 'poor', 'not addressed'] },
          suggested_response: { type: 'string' },
        },
        required: ['objection', 'handling', 'suggested_response'],
      },
    },
    scores: {
      type: 'object',
      properties: Object.fromEntries(SCORE_KEYS.map((k) => [k, { type: 'integer', minimum: 0, maximum: 10 }])),
      required: SCORE_KEYS,
    },
    probability_reasoning: { type: 'string' },
    conversion_probability: { type: 'integer', minimum: 0, maximum: 100 },
    suggestions: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 },
    recommendations: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 3 },
    next_steps: { type: 'array', items: { type: 'string' }, maxItems: 3 },
  },
  required: [
    'summary', 'call_type', 'customer_needs', 'buyer_sentiment', 'strengths', 'mistakes', 'objections',
    'scores', 'probability_reasoning', 'conversion_probability', 'suggestions', 'recommendations', 'next_steps',
  ],
};

const SYSTEM_PROMPT = `You are a senior sales coach who reviews recorded sales calls and coaches the salesperson ("the rep").

The transcript comes from automatic speech recognition: it has no speaker labels and may contain recognition errors. Work out from context who is the rep and who is the prospect/customer.

Rules:
- Base every statement on the transcript. Never invent names, prices, products or events that are not there.
- Every call has room to improve: always list at least two mistakes or missed opportunities (for example no rapport building, closed questions, no value explained, no urgency, no confirmed next step, talking over the customer, robotic script reading, repeating questions).
- "evidence" must be a short quote or close paraphrase of what the rep actually said or failed to do.
- "better_approach" and "suggested_response" must be concrete wording the rep could use next time.
- "suggestions" are specific tactical fixes for this call; "recommendations" are the rep's personal development priorities (skills or habits to practise).
- "next_steps" are actions the rep should take with THIS prospect after the call (follow-ups, materials to send, meetings to book). Empty if the deal is clearly lost.
- Scores are 0-10 where 5 is average, 8+ is genuinely strong.
- conversion_probability is the chance this call leads to a sale or the rep's desired outcome:
  0-15 prospect clearly declined; 16-35 little interest or major unresolved objections; 36-55 some interest but no commitment;
  56-75 clear interest and an agreed next step; 76-100 verbal commitment or purchase made.
- If this is not a sales call (e.g. customer support), coach the rep on customer experience, retention and upsell, and treat conversion as the likelihood of a positive business outcome.
- Be direct and specific. Write the summary in 2-4 sentences and keep every other string under 30 words.`;

function fmtTime(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function transcriptToText(segments) {
  return segments.map((s) => `[${fmtTime(s.start)}] ${s.text}`).join('\n');
}

async function chat(server, body, { signal, onToken } = {}) {
  const res = await fetch(`${server.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({ ...body, stream: true, timings_per_token: false }),
  });
  if (!res.ok) throw new Error(`Analysis engine error ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let tokens = 0;
  let timings = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      const evt = JSON.parse(data);
      if (evt.error) throw new Error(evt.error.message || 'Analysis engine error');
      const delta = evt.choices?.[0]?.delta?.content;
      if (delta) {
        text += delta;
        tokens++;
        onToken?.(tokens, text);
      }
      if (evt.timings) timings = evt.timings;
    }
  }
  return { text, timings };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a !== -1 && b > a) return JSON.parse(text.slice(a, b + 1));
    throw new Error('The analysis model returned malformed output. Try again.');
  }
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(n) || 0)));

// Small models occasionally degenerate inside a string field and emit schema
// fragments like ",conversion_probability_0_100_0.15". Drop those.
const isJunk = (s) => !/[a-z]{2,}/i.test(s) || /\w+_\w+_\w+/.test(s);
const cleanStr = (v, minWords = 1) => {
  const s = String(v ?? '').trim();
  return !s || isJunk(s) || s.split(/\s+/).length < minWords ? '' : s;
};
const strList = (v) => (Array.isArray(v) ? v.map((x) => cleanStr(x)).filter(Boolean) : []);

function normalize(raw) {
  const scores = Object.fromEntries(SCORE_KEYS.map((k) => [k, clamp(raw.scores?.[k], 0, 10)]));
  const reasoning = cleanStr(raw.probability_reasoning, 4);
  const rubric = Math.round((SCORE_KEYS.reduce((sum, k) => sum + scores[k], 0) / SCORE_KEYS.length) * 10);
  let modelProbability = clamp(raw.conversion_probability, 0, 100);
  // A zero estimate with a broken rationale is a generation failure, not a signal.
  if (!reasoning && modelProbability === 0) modelProbability = null;
  // A 2B model's single number is noisy; blend it with its own rubric scores.
  const probability = modelProbability === null ? rubric : clamp(modelProbability * 0.7 + rubric * 0.3, 0, 100);
  return {
    summary: cleanStr(raw.summary, 4),
    call_type: raw.call_type || 'other',
    customer_needs: strList(raw.customer_needs),
    buyer_sentiment: raw.buyer_sentiment || 'neutral',
    strengths: strList(raw.strengths),
    mistakes: (raw.mistakes || [])
      .map((m) => ({ ...m, title: cleanStr(m?.title), evidence: cleanStr(m?.evidence), better_approach: cleanStr(m?.better_approach) }))
      .filter((m) => m.title && (m.evidence || m.better_approach)),
    objections: (raw.objections || [])
      .map((o) => ({ ...o, objection: cleanStr(o?.objection), suggested_response: cleanStr(o?.suggested_response) }))
      .filter((o) => o.objection),
    scores,
    probability_reasoning: reasoning,
    conversion_probability: probability,
    probability_breakdown: { model: modelProbability, rubric },
    suggestions: strList(raw.suggestions),
    recommendations: strList(raw.recommendations),
    next_steps: strList(raw.next_steps),
  };
}

// Rough budget: leave room for the system prompt and the JSON answer.
const approxTokens = (s) => Math.ceil(s.length / 3.6);

async function condense(server, transcriptText, { signal, onStatus }) {
  const lines = transcriptText.split('\n');
  const parts = [];
  let current = '';
  for (const line of lines) {
    if (current.length + line.length > 24_000 && current) {
      parts.push(current);
      current = '';
    }
    current += line + '\n';
  }
  if (current) parts.push(current);

  const notes = [];
  for (let i = 0; i < parts.length; i++) {
    onStatus?.(`Condensing long call · part ${i + 1} of ${parts.length}`);
    const { text } = await chat(server, {
      messages: [
        { role: 'system', content: 'You write dense, factual notes of sales call excerpts for a sales coach.' },
        {
          role: 'user',
          content: `Excerpt ${i + 1}/${parts.length} of an ASR transcript (no speaker labels):\n\n${parts[i]}\n\nWrite notes covering: what the rep said and asked, the prospect's needs, objections and reactions, commitments, and 3-5 short verbatim quotes that show the rep's technique. Keep the [m:ss] timestamps. Max 300 words.`,
        },
      ],
      temperature: 0.2,
      max_tokens: 600,
    }, { signal });
    notes.push(text.trim());
  }
  return notes.join('\n\n');
}

// True when the transcript would not leave room for the system prompt and answer.
function needsCondense(transcriptText) {
  const budget = config.llm.ctx - config.llm.maxOutputTokens - approxTokens(SYSTEM_PROMPT) - 300;
  return approxTokens(transcriptText) > budget;
}

async function analyze(server, segments, { duration, signal, onToken, onStatus } = {}) {
  let transcriptText = transcriptToText(segments);
  if (!transcriptText.trim()) throw new Error('No speech was detected in this recording.');

  let label = 'TRANSCRIPT';
  if (needsCondense(transcriptText)) {
    transcriptText = await condense(server, transcriptText, { signal, onStatus });
    label = 'CALL NOTES (condensed from a long transcript)';
  }

  onStatus?.('Analyzing call');
  return analyzeTranscript(server, transcriptText, { duration, label, signal, onToken });
}

// One analysis pass over a transcript (or condensed notes) that already fits.
async function analyzeTranscript(server, transcriptText, { duration, label = 'TRANSCRIPT', signal, onToken } = {}) {
  const { text, timings } = await chat(server, {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Call length: ${fmtTime(duration || 0)}\n\n${label}:\n${transcriptText}\n\nAnalyze this call and coach the rep. Respond with the JSON object only.`,
      },
    ],
    temperature: 0.3,
    top_p: 0.8,
    top_k: 20,
    max_tokens: config.llm.maxOutputTokens,
    response_format: { type: 'json_schema', json_schema: { name: 'sales_call_analysis', schema: SCHEMA } },
  }, { signal, onToken });

  return { analysis: normalize(parseJson(text)), timings };
}

module.exports = {
  analyze, analyzeTranscript, condense, needsCondense,
  normalize, transcriptToText, fmtTime, SCHEMA,
};
