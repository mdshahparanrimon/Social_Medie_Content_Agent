import Anthropic from '@anthropic-ai/sdk';
import { httpError } from '../errors.js';

export const label = 'Claude';
export const isConfigured = (config) => Boolean(config.anthropic_api_key);
export const model = (config) => config.anthropic_model;

// USD per million tokens: [input, output]
const PRICES = {
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};

// Models that accept server-side refusal fallbacks ("default" mode).
const FALLBACK_MODELS = ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1'];

let client = null;
let clientKey = null;

function getClient(apiKey) {
  if (!client || clientKey !== apiKey) {
    client = new Anthropic({ apiKey });
    clientKey = apiKey;
  }
  return client;
}

function withFallbacks(params) {
  if (FALLBACK_MODELS.includes(params.model)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  return params;
}

function usageOf(response) {
  const { input_tokens, output_tokens } = response.usage;
  const price = PRICES[response.model];
  return {
    model: response.model,
    input_tokens,
    output_tokens,
    cost_usd: price ? (input_tokens * price[0] + output_tokens * price[1]) / 1e6 : null,
  };
}

// Chat messages (see llm/chat.js for the shape) -> Claude's format. Claude's own earlier replies are sent back
// unchanged (raw), so thinking blocks stay valid; replies from another provider are rebuilt from text + tool calls.
export function toClaudeMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'user') return { role: 'user', content: m.content };
    if (m.role === 'tool') {
      return {
        role: 'user',
        content: m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.is_error && { is_error: true }) })),
      };
    }
    if (m.raw?.provider === 'anthropic') return { role: 'assistant', content: m.raw.value };
    const content = [];
    if (m.content) content.push({ type: 'text', text: m.content });
    for (const call of m.tool_calls || []) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
    return { role: 'assistant', content };
  });
}

// One step of a tool-using conversation: Claude answers, or asks for tools (which the agent loop runs).
export async function chat({ config, system, messages, tools }) {
  const params = withFallbacks({
    model: model(config),
    max_tokens: 16000,
    system,
    messages: toClaudeMessages(messages),
    tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    output_config: { effort: 'medium' },
  });
  const response = await send(config, params);
  if (response.stop_reason === 'refusal') {
    const why = response.stop_details?.explanation;
    throw httpError(422, `Claude declined this request${why ? `: ${why}` : '.'}`);
  }
  if (response.stop_reason === 'max_tokens') throw httpError(502, 'Claude response was cut off. Try again.');
  return {
    text: response.content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    tool_calls: response.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input })),
    raw: response.content,
    usage: usageOf(response),
  };
}

async function send(config, params) {
  try {
    return await getClient(config.anthropic_api_key).beta.messages.create(params);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw httpError(400, 'Claude API key is invalid. Check it in Settings.');
    if (err instanceof Anthropic.RateLimitError) throw httpError(429, 'Claude rate limit reached. Wait a minute and try again.');
    if (err instanceof Anthropic.APIError) throw httpError(502, `Claude API error (${err.status}): ${err.message}`);
    throw httpError(500, `Claude request failed: ${err.message}`);
  }
}

// Claude enforces the schema itself (structured outputs), so no schema text goes in the prompt.
export async function complete({ config, system, prompt, schema, effort }) {
  const params = withFallbacks({
    model: model(config),
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content: prompt }],
    output_config: { effort, format: { type: 'json_schema', schema } },
  });

  let response;
  try {
    response = await getClient(config.anthropic_api_key).beta.messages.create(params);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw httpError(400, 'Claude API key is invalid. Check it in Settings.');
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw httpError(429, 'Claude rate limit reached. Wait a minute and try again.');
    }
    if (err instanceof Anthropic.APIError) {
      throw httpError(502, `Claude API error (${err.status}): ${err.message}`);
    }
    throw httpError(500, `Claude request failed: ${err.message}`);
  }

  if (response.stop_reason === 'refusal') {
    const why = response.stop_details?.explanation;
    throw httpError(422, `Claude declined this request${why ? `: ${why}` : '.'}`);
  }
  if (response.stop_reason === 'max_tokens') {
    throw httpError(502, 'Claude response was cut off. Try again.');
  }

  const { input_tokens, output_tokens } = response.usage;
  const price = PRICES[response.model];
  return {
    text: response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(''),
    usage: {
      model: response.model,
      input_tokens,
      output_tokens,
      cost_usd: price ? (input_tokens * price[0] + output_tokens * price[1]) / 1e6 : null,
    },
  };
}
