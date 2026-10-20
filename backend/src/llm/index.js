import { repo } from '../db/index.js';
import { getConfig } from '../settings.js';
import { httpError } from '../errors.js';
import { parseJSON, checkSchema } from './json.js';
import * as gemini from './gemini.js';
import * as openaiCompat from './openaiCompat.js';
import * as anthropic from './anthropic.js';

// The AI provider is chosen in Settings; every agent goes through generateJSON.
const PROVIDERS = { gemini, openai_compat: openaiCompat, anthropic };

export function aiStatus(config) {
  const provider = PROVIDERS[config.ai_provider];
  return {
    provider: config.ai_provider,
    label: provider.label,
    model: provider.model(config),
    ready: provider.isConfigured(config),
  };
}

// One AI call that must return JSON matching `schema`. Invalid output is retried once.
export async function generateJSON({ task, system, prompt, schema, effort = 'medium' }) {
  const config = await getConfig();
  const provider = PROVIDERS[config.ai_provider];
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
