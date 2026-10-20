import { httpError } from '../errors.js';
import { fetchWithRetry } from './http.js';
import { schemaInstructions } from './json.js';

// Any OpenAI-compatible chat API: Groq, OpenRouter, a local Ollama, etc.
export const label = 'OpenAI-compatible';

const isLocal = (url) => /\/\/(localhost|127\.0\.0\.1)[:/]/.test(url);

export const isConfigured = (config) =>
  Boolean(
    config.openai_compat_base_url &&
      config.openai_compat_model &&
      (config.openai_compat_api_key || isLocal(config.openai_compat_base_url)),
  );
export const model = (config) => config.openai_compat_model;

export async function complete({ config, system, prompt, schema }) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.openai_compat_api_key) headers.Authorization = `Bearer ${config.openai_compat_api_key}`;

  const res = await fetchWithRetry(
    `${config.openai_compat_base_url.replace(/\/+$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model(config),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `${prompt}\n\n${schemaInstructions(schema)}` },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 4096,
      }),
    },
    'AI provider',
  );
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  if (!text) throw httpError(502, 'The AI provider returned an empty response.');
  return {
    text,
    usage: {
      model: data.model || model(config),
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
      cost_usd: null,
    },
  };
}
