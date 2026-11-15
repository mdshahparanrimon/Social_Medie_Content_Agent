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

function headersFor(config) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.openai_compat_api_key) headers.Authorization = `Bearer ${config.openai_compat_api_key}`;
  return headers;
}

// Chat messages (see llm/chat.js) -> OpenAI chat format: tool results are one "tool" message each.
function toOpenAiMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'tool') for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    else {
      out.push({
        role: 'assistant',
        content: m.content || null,
        ...(m.tool_calls?.length && {
          tool_calls: m.tool_calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })),
        }),
      });
    }
  }
  return out;
}

// One step of a tool-using conversation (the agent loop runs the tools).
export async function chat({ config, system, messages, tools }) {
  const res = await fetchWithRetry(
    `${config.openai_compat_base_url.replace(/\/+$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: headersFor(config),
      body: JSON.stringify({
        model: model(config),
        messages: toOpenAiMessages(system, messages),
        tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
        max_tokens: 4096,
      }),
    },
    'AI provider',
  );
  const data = await res.json();
  const message = data.choices?.[0]?.message || {};
  const calls = (message.tool_calls || []).map((c, i) => {
    let args = {};
    try {
      args = JSON.parse(c.function?.arguments || '{}');
    } catch {
      args = { _unparsed: String(c.function?.arguments) };
    }
    return { id: c.id || `call_${Date.now()}_${i}`, name: c.function?.name, args };
  });
  if (!message.content && !calls.length) throw httpError(502, 'The AI provider returned an empty response.');
  return {
    text: message.content || '',
    tool_calls: calls,
    raw: null,
    usage: {
      model: data.model || model(config),
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
      cost_usd: null,
    },
  };
}

export async function complete({ config, system, prompt, schema }) {
  const headers = headersFor(config);

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
