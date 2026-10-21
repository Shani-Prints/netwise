import { AISDKError, APICallError, type LanguageModel } from 'ai';
import { describeError, isNetworkError } from '../lib/errorLog';
import { classifyFailure, readConfig } from '../lib/ai/fallback';
import { buildModel, getKeys, resolveProviderOrder } from '../lib/ai/providers';

export const BUSY_MESSAGE_HE = 'המערכת עמוסה כרגע ולא הצלחתי לענות. הנתונים ששמרת נשמרו; נסו שוב בעוד רגע.';

export interface ProviderEntry {
  name: string;
  model: LanguageModel;
  /** Short hash of the API key behind this entry (several entries can share a provider name, one per key). Never the key. */
  keyId?: string;
  /** Masked key ("…ab12") for logs. */
  keyMask?: string;
}

type Env = Record<string, string | undefined>;

/**
 * One entry per (provider, key), in the order of resolveProviderOrder(): LLM_PROVIDER_ORDER or the default order from
 * src/lib/ai/providers.ts, minus AI_DISABLED_PROVIDERS, minus providers without a key. Keys come from env only.
 * Models, defaults and env names (GEMINI_API_KEYS, MISTRAL_MODEL...) are shared with /api/ai-chat.
 */
export function buildProviders(env: Env = process.env): ProviderEntry[] {
  const out: ProviderEntry[] = [];
  for (const name of resolveProviderOrder(env)) {
    for (const key of getKeys(name, env)) {
      out.push({ name, model: buildModel(name, key, env).model, keyId: key.id, keyMask: key.mask });
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

/**
 * What kind of failure is this?
 *  - retryable: ONLY network errors and timeouts (408, no HTTP response, connection errors): back off and retry the same key
 *  - provider:  this key/provider cannot answer (429 quota, 5xx, 418 blocked, bad key, bad request, empty model output): do
 *               not retry it; move on (withFallback decides whether to try the provider's next key or the next provider)
 *  - bug:       anything else (a TypeError in our own code, a failed assertion...). Retrying cannot help and calling it
 *               "busy" would hide it, so it is rethrown immediately and surfaces as an error log + a 500.
 */
export type ErrorClass = 'retryable' | 'provider' | 'bug';

export function classifyError(err: unknown): ErrorClass {
  const s = statusOf(err);
  if (typeof s === 'number') return s === 408 ? 'retryable' : 'provider';
  if (APICallError.isInstance(err)) return 'retryable'; // the call never got an HTTP response
  if (isNetworkError(err)) return 'retryable';
  if (AISDKError.isInstance(err)) return 'provider';
  return 'bug';
}

/** Only network errors and timeouts are worth retrying on the same key. */
export function isRetryable(err: unknown): boolean {
  return classifyError(err) === 'retryable';
}

// In-process pauses (this server instance only; /api/ai-chat keeps its pauses in the shared store instead).
// 'key:<keyId>' = one API key (429 quota, 401/403 rejected), 'provider:<name>' = the whole provider (418 blocked network).
const pausedUntil = new Map<string, number>();
export function resetProviderPauses(): void {
  pausedUntil.clear();
}
const isPaused = (p: ProviderEntry, at: number): boolean =>
  (pausedUntil.get(`provider:${p.name}`) ?? 0) > at || (p.keyId !== undefined && (pausedUntil.get(`key:${p.keyId}`) ?? 0) > at);

/**
 * Runs `attempt` on each provider entry in order (one entry per API key).
 *  - network error / timeout: back off exponentially and retry the same entry
 *  - 429: pause THAT key (Retry-After or AI_COOLDOWN_SECONDS) and go on to the provider's next key, no retry
 *  - 401/403: pause that key for AI_AUTH_COOLDOWN_SECONDS, next key
 *  - 418 (blocked network): pause the whole provider for AI_AUTH_COOLDOWN_SECONDS, next provider
 *  - 5xx or any other provider-side failure: next PROVIDER immediately, no retry, no other key of the same provider
 * Throws AllProvidersFailedError when none succeeds (after ONE summary log line with the reason code all_providers_failed).
 * A failure that is not a provider/network error is a bug: it is logged and rethrown at once. Never logs prompts,
 * payloads or keys (only the masked last 4 characters).
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
  const cfg = readConfig();
  const skippedProviders = new Set<string>(); // gave a provider-side failure during THIS call
  for (const p of providers) {
    if (skippedProviders.has(p.name) || isPaused(p, now())) continue;
    const label = p.keyMask ? `${p.name} key ${p.keyMask}` : p.name;
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
        const giveUp = kind !== 'retryable' || i === retries || now() - startedAt >= budget; // a slow provider cannot hold the request
        if (giveUp) {
          if (kind === 'provider') {
            const f = classifyFailure(err);
            if (f.kind === 'rate_limit' || f.kind === 'auth') {
              const ms = f.kind === 'rate_limit' ? (f.retryAfterMs ?? cfg.rateLimitCooldownMs) : cfg.authCooldownMs;
              if (p.keyId !== undefined) pausedUntil.set(`key:${p.keyId}`, now() + ms); // only this key
            } else {
              skippedProviders.add(p.name); // 5xx, 418, bad request...: the next KEY of this provider would fail the same way
              if (f.kind === 'blocked' && p.keyId !== undefined) pausedUntil.set(`provider:${p.name}`, now() + cfg.authCooldownMs);
            }
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
