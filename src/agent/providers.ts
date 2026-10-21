import { createGoogle } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { AISDKError, APICallError, type LanguageModel } from 'ai';
import { createHash } from 'node:crypto';
import { describeError, isNetworkError } from '../lib/errorLog';

export const BUSY_MESSAGE_HE = 'המערכת עמוסה כרגע ולא הצלחתי לענות. הנתונים נשמרו, אפשר לנסות שוב בעוד רגע.';

export interface ProviderEntry {
  name: string;
  model: LanguageModel;
  /** Short hash of the API key behind this entry (a provider can have several keys, one entry each). Never the key itself. */
  keyId?: string;
  /** Masked key ("…ab12") for logs: the only form of a key that is ever printed. */
  keyMask?: string;
}

type Env = Record<string, string | undefined>;

// Model ids: gemini-3.8-flash is the id used in the current AI SDK Google docs (and it answered on the live API).
// Groq: openai/gpt-oss-120b is a production model with tool use in both the AI SDK Groq docs and Groq's tool-use docs,
// and it is available to the project key (llama-3.3-70b-versatile is not). NOTE: neither doc states Hebrew support.
// TODO(openrouter): the OpenRouter docs page could not be fetched; set OPENROUTER_MODEL to a verified id.
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';
const DEFAULT_OPENROUTER_MODEL = 'openrouter/free';
const DEFAULT_MISTRAL_MODEL = 'mistral-small-latest';

const DEFAULT_ORDER = 'gemini,groq,openrouter';

/** Per provider: the env variable that holds one key, the one that holds a comma separated list, and how to build the model. */
const PROVIDERS: Record<string, { keyVar: string; keysVar: string; build: (apiKey: string, env: Env) => LanguageModel }> = {
  gemini: { keyVar: 'GEMINI_API_KEY', keysVar: 'GEMINI_API_KEYS', build: (k, env) => createGoogle({ apiKey: k })(env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL) },
  groq: { keyVar: 'GROQ_API_KEY', keysVar: 'GROQ_API_KEYS', build: (k, env) => createGroq({ apiKey: k })(env.GROQ_MODEL || DEFAULT_GROQ_MODEL) },
  mistral: { keyVar: 'MISTRAL_API_KEY', keysVar: 'MISTRAL_API_KEYS', build: (k, env) => createMistral({ apiKey: k })(env.MISTRAL_MODEL || DEFAULT_MISTRAL_MODEL) },
  openrouter: {
    keyVar: 'OPENROUTER_API_KEY',
    keysVar: 'OPENROUTER_API_KEYS',
    build: (k, env) => createOpenRouter({ apiKey: k }).chat(env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL),
  },
};

/** All distinct keys of a provider: NAME_API_KEYS=k1,k2 and/or the singular NAME_API_KEY, in that order. */
function keysOf(name: string, env: Env): string[] {
  const cfg = PROVIDERS[name];
  if (!cfg) return [];
  const all = `${env[cfg.keysVar] ?? ''},${env[cfg.keyVar] ?? ''}`.split(',').map((k) => k.trim()).filter(Boolean);
  return [...new Set(all)];
}

/**
 * One entry per (provider, key), in LLM_PROVIDER_ORDER (default: DEFAULT_ORDER). A provider without a key is skipped. Keys are
 * read from env only; only a hash and the last 4 characters of a key are ever kept for logs.
 */
export function buildProviders(env: Env = process.env): ProviderEntry[] {
  const order = (env.LLM_PROVIDER_ORDER?.trim() || DEFAULT_ORDER)
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  const out: ProviderEntry[] = [];
  for (const name of [...new Set(order)]) {
    for (const key of keysOf(name, env)) {
      out.push({
        name,
        model: PROVIDERS[name]!.build(key, env),
        keyId: createHash('sha256').update(key).digest('hex').slice(0, 12),
        keyMask: `…${key.slice(-4)}`,
      });
    }
  }
  return out;
}

export class AllProvidersFailedError extends Error {
  constructor() {
    super('all_providers_failed');
    this.name = 'AllProvidersFailedError';
  }
}

export interface FallbackOptions {
  /** Retries per provider after the first attempt (exponential backoff). */
  retries?: number;
  baseDelayMs?: number;
  /** Once a provider has used this much time (all its tries), stop retrying it and move on. Default 25s. */
  providerBudgetMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const statusOf = (err: unknown): number | undefined =>
  APICallError.isInstance(err) ? err.statusCode : (err as { statusCode?: number } | null)?.statusCode;

// Keys that are cooling down (this server instance only): a rate-limited or rejected key is skipped by later requests too.
const pausedUntil = new Map<string, number>();
export function resetKeyPauses(): void {
  pausedUntil.clear();
}
const envSeconds = (name: string, fallback: number): number => (Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback) * 1000;

const retryableStatus = (s: number) => s === 429 || s === 408 || s >= 500;

/**
 * What kind of failure is this?
 *  - retryable: the provider or the network is having a moment (429, 408, 5xx, timeout, connection error): back off and retry
 *  - provider:  this provider cannot answer (bad key, bad request, malformed or empty model output): try the NEXT provider
 *  - bug:       anything else (a TypeError in our own code, a failed assertion...). Retrying cannot help and calling it
 *               "busy" would hide it, so it is rethrown immediately and surfaces as an error log + a 500.
 */
export type ErrorClass = 'retryable' | 'provider' | 'bug';

export function classifyError(err: unknown): ErrorClass {
  if (APICallError.isInstance(err)) {
    if (err.statusCode === undefined) return 'retryable'; // the call never got an HTTP response
    return retryableStatus(err.statusCode) ? 'retryable' : 'provider';
  }
  const s = (err as { statusCode?: unknown } | null)?.statusCode;
  if (typeof s === 'number') return retryableStatus(s) ? 'retryable' : 'provider';
  if (isNetworkError(err)) return 'retryable';
  if (AISDKError.isInstance(err)) return 'provider';
  return 'bug';
}

/** 429, 5xx, network errors and timeouts are worth retrying; other 4xx (bad request, bad key) are not. */
export function isRetryable(err: unknown): boolean {
  return classifyError(err) === 'retryable';
}

/**
 * Runs `attempt` on each provider entry in order (one entry per API key). Retryable failures back off exponentially (few
 * retries), then the next entry is tried. A 429 is not retried when the same provider has another key left: that key is paused
 * (AI_COOLDOWN_SECONDS, default 60) and the next key is used; 401/403 pause the key for AI_AUTH_COOLDOWN_SECONDS (default 3600).
 * Any other failure that survives its retries (5xx, bad request...) skips the provider's remaining keys: they would fail alike. Throws AllProvidersFailedError when none succeeds (after ONE summary log line with the reason code
 * all_providers_failed). A failure that is not a provider/network error is a bug: it is logged and rethrown at once.
 * Never logs prompts, payloads or keys.
 */
export async function withFallback<T>(
  providers: ProviderEntry[],
  attempt: (p: ProviderEntry) => Promise<T>,
  opts: FallbackOptions = {},
): Promise<{ value: T; provider: string }> {
  const retries = opts.retries ?? 2;
  const base = opts.baseDelayMs ?? 500;
  const budget = opts.providerBudgetMs ?? 25_000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const skipped = new Set<string>(); // providers that failed on the provider side during THIS call
  for (const [index, p] of providers.entries()) {
    if (skipped.has(p.name) || (p.keyId !== undefined && (pausedUntil.get(p.keyId) ?? 0) > now())) continue;
    const label = p.keyMask ? `${p.name} key ${p.keyMask}` : p.name;
    const nextKeyOfSameProvider = providers.slice(index + 1).some((q) => q.name === p.name && (q.keyId === undefined || (pausedUntil.get(q.keyId) ?? 0) <= now()));
    const startedAt = now();
    for (let i = 0; i <= retries; i++) {
      try {
        const value = await attempt(p);
        console.info(`[netwise] provider ${label} answered (try ${i + 1})`);
        return { value, provider: p.name };
      } catch (err) {
        const kind = classifyError(err);
        if (kind === 'bug') {
          console.error(
            `[netwise] provider ${label} failed with an internal error (${err instanceof Error ? err.name : 'unknown'}); not retried`,
          );
          throw err;
        }
        console.error(`[netwise] provider ${label} failed (status ${statusOf(err) ?? 'n/a'}, try ${i + 1})`);
        const status = statusOf(err);
        const giveUp = kind !== 'retryable' || i === retries || now() - startedAt >= budget || (status === 429 && nextKeyOfSameProvider); // a slow provider cannot hold the request
        if (giveUp) {
          if (status === 429 || status === 401 || status === 403) {
            if (p.keyId !== undefined) pausedUntil.set(p.keyId, now() + (status === 429 ? envSeconds('AI_COOLDOWN_SECONDS', 60) : envSeconds('AI_AUTH_COOLDOWN_SECONDS', 3600)));
          } else {
            skipped.add(p.name);
          }
          console.error(`[netwise] provider ${label} given up: ${describeError(err)}`);
          break;
        }
        await sleep(base * 2 ** i + Math.floor(Math.random() * base * 0.2));
      }
    }
  }
  console.error(`[netwise] chat: all_providers_failed (tried: ${[...new Set(providers.map((p) => p.name))].join(', ') || 'none'})`);
  throw new AllProvidersFailedError();
}
