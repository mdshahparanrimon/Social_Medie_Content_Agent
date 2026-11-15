import { repo } from '../db/index.js';
import { getConfig } from '../settings.js';
import { httpError } from '../errors.js';
import { parseJSON, checkSchema } from './json.js';
import * as gemini from './gemini.js';
import * as openaiCompat from './openaiCompat.js';
import * as anthropic from './anthropic.js';
import * as mcp from './mcp.js';

// The AI provider is chosen in Settings; every agent goes through generateJSON.
// mcp has no `complete`: with it, Claude writes from claude.ai instead of the app calling an AI.
const PROVIDERS = { gemini, openai_compat: openaiCompat, anthropic, mcp };
const MODEL_KEYS = { gemini: 'gemini_model', openai_compat: 'openai_compat_model', anthropic: 'anthropic_model' };

// Whether a provider can be called by the app (everything except "mcp", where Claude itself writes), and which model it uses.
export function providerInfo(config, providerKey, model) {
  const provider = PROVIDERS[providerKey];
  if (!provider) return { key: providerKey, usable: false, reason: 'unknown provider' };
  if (!provider.complete) return { key: providerKey, usable: false, reason: provider.unavailable };
  if (!provider.isConfigured(config)) return { key: providerKey, usable: false, reason: `${provider.label} is not set up (add its API key in Settings → AI).` };
  const key = MODEL_KEYS[providerKey];
  return { key: providerKey, usable: true, model: model || (key ? config[key] : provider.model(config)) };
}

export function aiStatus(config) {
  const provider = PROVIDERS[config.ai_provider];
  return {
    provider: config.ai_provider,
    label: provider.label,
    model: provider.model(config),
    ready: provider.isConfigured(config),
  };
}

// One step of a tool-using chat (agent/chat.js runs the loop and the tools). Returns
// { text, tool_calls: [{ id, name, args }], raw: { provider, value } } and logs the usage.
export async function chatStep({ system, messages, tools }) {
  const config = await getConfig();
  const provider = PROVIDERS[config.ai_provider];
  if (!provider) throw httpError(400, `Unknown AI provider "${config.ai_provider}".`);
  if (!provider.chat) {
    throw httpError(400, provider.unavailable || `${provider.label} can't chat. Pick another AI provider in Settings → AI.`);
  }
  if (!provider.isConfigured(config)) {
    throw httpError(400, `${provider.label} is not set up yet. Add its API key in Settings → AI.`);
  }
  const { text, tool_calls, raw, usage } = await provider.chat({ config, system, messages, tools });
  await repo.logUsage({ task: 'chat', provider: config.ai_provider, ...usage });
  return { text, tool_calls, raw: raw == null ? null : { provider: config.ai_provider, value: raw } };
}

// One AI call that must return JSON matching `schema`. Invalid output is retried once.
// provider/model: use another configured provider or model for this call (e.g. the independent content reviewer).
export async function generateJSON({ task, system, prompt, schema, effort = 'medium', provider: providerKey, model }) {
  let config = await getConfig();
  if (providerKey) config = { ...config, ai_provider: providerKey };
  if (model && MODEL_KEYS[config.ai_provider]) config = { ...config, [MODEL_KEYS[config.ai_provider]]: model };
  const provider = PROVIDERS[config.ai_provider];
  if (!provider) throw httpError(400, `Unknown AI provider "${config.ai_provider}".`);
  if (!provider.complete) throw httpError(400, provider.unavailable);
  if (!provider.isConfigured(config)) {
    throw httpError(400, `${provider.label} is not set up yet. Add its API key in Settings → AI.`);
  }

  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text, usage } = await provider.complete({ config, system, prompt, schema, effort });
    await repo.logUsage({ task, provider: config.ai_provider, ...usage });
    try {
      const value = parseJSON(text);
      checkSchema(schema, value);
      return value;
    } catch (err) {
      lastError = err;
    }
  }
  throw httpError(502, `The AI returned unusable output twice (${lastError.message}). Try again or pick another model.`);
}
