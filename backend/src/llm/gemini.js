import { httpError } from '../errors.js';
import { fetchWithRetry } from './http.js';
import { schemaInstructions } from './json.js';

export const label = 'Google Gemini';
export const isConfigured = (config) => Boolean(config.gemini_api_key);
export const model = (config) => config.gemini_model;

// Overloaded (503) models are common on the free tier; the fallback model usually runs on separate capacity.
export async function complete({ config, system, prompt, schema }) {
  const fallback = config.gemini_fallback_model?.trim();
  try {
    return await generate(model(config), { config, system, prompt, schema });
  } catch (err) {
    if (err.upstreamStatus !== 503 || !fallback || fallback === model(config)) throw err;
    try {
      return await generate(fallback, { config, system, prompt, schema }, 1);
    } catch {
      throw err;
    }
  }
}

// Chat messages (see llm/chat.js) -> Gemini contents. Gemini's own earlier turns are sent back unchanged (raw):
// Gemini 3 requires the thought signatures on its function calls to come back as they were.
export function toGeminiContents(messages) {
  return messages.map((m) => {
    if (m.role === 'user') return { role: 'user', parts: [{ text: m.content }] };
    if (m.role === 'tool') {
      return {
        role: 'user',
        parts: m.results.map((r) => ({ functionResponse: { ...(r.id && !r.id.startsWith('call_') && { id: r.id }), name: r.name, response: r.is_error ? { error: r.content } : { result: r.content } } })),
      };
    }
    if (m.raw?.provider === 'gemini') return { role: 'model', parts: m.raw.value };
    const parts = [];
    if (m.content) parts.push({ text: m.content });
    for (const call of m.tool_calls || []) parts.push({ functionCall: { name: call.name, args: call.args } });
    return { role: 'model', parts };
  });
}

// One step of a tool-using conversation (the agent loop runs the tools).
export async function chat({ config, system, messages, tools }) {
  const modelName = model(config);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`;
  const res = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini_api_key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: toGeminiContents(messages),
        tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }],
      }),
    },
    'Gemini',
  );
  const data = await res.json();
  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const calls = parts.filter((p) => p.functionCall);
  const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('');
  if (!text && !calls.length) {
    const reason = candidate?.finishReason || data.promptFeedback?.blockReason || 'unknown reason';
    throw httpError(502, `Gemini returned no answer (${reason}).`);
  }
  const meta = data.usageMetadata || {};
  return {
    text,
    tool_calls: calls.map((p, i) => ({ id: p.functionCall.id || `call_${Date.now()}_${i}`, name: p.functionCall.name, args: p.functionCall.args || {} })),
    raw: parts,
    usage: {
      model: modelName,
      input_tokens: meta.promptTokenCount ?? 0,
      output_tokens: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
      cost_usd: null,
    },
  };
}

async function generate(modelName, { config, system, prompt, schema }, retries) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`;
  const res = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini_api_key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: `${prompt}\n\n${schemaInstructions(schema)}` }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    },
    'Gemini',
    retries,
  );
  const data = await res.json();
  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts || []).map((part) => part.text || '').join('');
  if (!text) {
    const reason = candidate?.finishReason || data.promptFeedback?.blockReason || 'unknown reason';
    throw httpError(502, `Gemini returned no text (${reason}).`);
  }
  const meta = data.usageMetadata || {};
  return {
    text,
    usage: {
      model: modelName,
      input_tokens: meta.promptTokenCount ?? 0,
      output_tokens: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
      cost_usd: null,
    },
  };
}
