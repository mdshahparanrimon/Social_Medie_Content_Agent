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
