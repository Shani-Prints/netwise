import { createGoogle } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import { createHash } from 'node:crypto';

type Env = Record<string, string | undefined>;

export type ProviderId = 'gemini' | 'mistral' | 'groq' | 'openrouter';

/**
 * PRIORITY ORDER. The first provider is tried first; the next one is used only when every key of the previous one is
 * cooling down or failing. Reorder / remove entries here to change the behaviour.
 *
 * Groq is configured below but left out of the default order (it is blocked on some networks, e.g. NetFree answers 418).
 * To use it again: add 'groq' to this array (or to LLM_PROVIDER_ORDER) and make sure it is not in AI_DISABLED_PROVIDERS.
 */
export const PROVIDER_ORDER: ProviderId[] = ['gemini', 'mistral', 'openrouter'];

const csv = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/** Providers switched off without a code change: AI_DISABLED_PROVIDERS=groq,mistral */
export const disabledProviders = (env: Env = process.env): Set<string> => new Set(csv(env.AI_DISABLED_PROVIDERS));

/**
 * The order actually used by BOTH chat routes: LLM_PROVIDER_ORDER if set, else PROVIDER_ORDER; unknown names and
 * AI_DISABLED_PROVIDERS removed. (Keys are checked separately: a provider without a key is skipped later.)
 */
export function resolveProviderOrder(env: Env = process.env): ProviderId[] {
  const requested = csv(env.LLM_PROVIDER_ORDER);
  const order = requested.length > 0 ? requested : PROVIDER_ORDER;
  const disabled = disabledProviders(env);
  return [...new Set(order)].filter((p): p is ProviderId => p in PROVIDERS && !disabled.has(p));
}

interface ProviderConfig {
  /** Env vars holding the key(s), in order of precedence. Comma-separated lists are supported in each. */
  envKeys: string[];
  /** Env var that overrides the model id. */
  envModel: string;
  defaultModel: string;
  createModel(apiKey: string, modelId: string): LanguageModel;
}

const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  gemini: {
    envKeys: ['GEMINI_API_KEYS', 'GEMINI_API_KEY'],
    envModel: 'GEMINI_MODEL',
    defaultModel: 'gemini-3.8-flash',
    createModel: (apiKey, id) => createGoogle({ apiKey })(id),
  },
  mistral: {
    envKeys: ['MISTRAL_API_KEYS', 'MISTRAL_API_KEY'],
    envModel: 'MISTRAL_MODEL',
    defaultModel: 'mistral-small-latest',
    createModel: (apiKey, id) => createMistral({ apiKey })(id),
  },
  groq: {
    envKeys: ['GROQ_API_KEYS', 'GROQ_API_KEY'],
    envModel: 'GROQ_MODEL',
    defaultModel: 'llama-3.3-70b-versatile',
    createModel: (apiKey, id) => createGroq({ apiKey })(id),
  },
  openrouter: {
    // OpenRouter's official AI SDK provider (@openrouter/ai-sdk-provider); it already points at openrouter.ai/api/v1.
    envKeys: ['OPENROUTER_API_KEYS', 'OPENROUTER_API_KEY'],
    envModel: 'OPENROUTER_MODEL',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free', // free models carry the ":free" suffix
    createModel: (apiKey, id) => createOpenRouter({ apiKey }).chat(id),
  },
};

/** A usable key: `id` is a short hash (safe to store/log-correlate), `mask` is what we print. Never log `secret`. */
export interface ApiKey {
  id: string;
  secret: string;
  mask: string;
}

/** "…ab12": the only form of a key that ever appears in logs. */
export const maskKey = (secret: string): string => `…${secret.slice(-4)}`;

const keyId = (secret: string): string => createHash('sha256').update(secret).digest('hex').slice(0, 12);

/** All distinct keys of a provider: GROQ_API_KEYS=k1,k2,k3 and/or the singular GROQ_API_KEY. */
export function getKeys(provider: ProviderId, env: Env = process.env): ApiKey[] {
  const seen = new Set<string>();
  const out: ApiKey[] = [];
  for (const name of PROVIDERS[provider].envKeys) {
    for (const raw of (env[name] ?? '').split(',')) {
      const secret = raw.trim();
      if (!secret || seen.has(secret)) continue;
      seen.add(secret);
      out.push({ id: keyId(secret), secret, mask: maskKey(secret) });
    }
  }
  return out;
}

export function buildModel(provider: ProviderId, key: ApiKey, env: Env = process.env): { model: LanguageModel; modelId: string } {
  const cfg = PROVIDERS[provider];
  const modelId = env[cfg.envModel]?.trim() || cfg.defaultModel;
  return { model: cfg.createModel(key.secret, modelId), modelId };
}

/** Providers that have at least one key configured, in PROVIDER_ORDER. */
export function configuredProviders(env: Env = process.env): ProviderId[] {
  return resolveProviderOrder(env).filter((p) => getKeys(p, env).length > 0);
}
