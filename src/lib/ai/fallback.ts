import { APICallError, streamText, type LanguageModel, type LanguageModelUsage, type ModelMessage, type StreamTextResult, type ToolSet } from 'ai';
import { describeError, isNetworkError } from '../errorLog';
import { buildModel, configuredProviders, getKeys, type ApiKey, type ProviderId } from './providers';
import { getKeyStateStore, type KeyStateStore } from './store';

type Env = Record<string, string | undefined>;
/** What streamText returns when called without tools. */
export type AiStream = StreamTextResult<ToolSet, any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// ---------------------------------------------------------------------------------------------------------------------
// Configuration (all tunable from env)
// ---------------------------------------------------------------------------------------------------------------------
export interface AiConfig {
  /** How long a key stays unavailable after a 429 (when the provider sends no Retry-After). */
  rateLimitCooldownMs: number;
  /** How long a key (401/403) or a whole provider (418, blocked network) stays unavailable. */
  authCooldownMs: number;
  /** Short pause for a key that just returned 5xx, so we do not hammer a struggling provider. */
  serverErrorCooldownMs: number;
  /** Attempts per key for transient errors (network, timeout). */
  maxAttempts: number;
  baseDelayMs: number;
  /** Cap on generated tokens per answer. */
  maxOutputTokens: number;
  /** How many of the latest messages are sent to the model. */
  maxHistoryMessages: number;
}

const num = (v: string | undefined, fallback: number): number => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);

export function readConfig(env: Env = process.env): AiConfig {
  return {
    rateLimitCooldownMs: num(env.AI_COOLDOWN_SECONDS, 60) * 1000,
    authCooldownMs: num(env.AI_AUTH_COOLDOWN_SECONDS, 3600) * 1000,
    serverErrorCooldownMs: num(env.AI_SERVER_ERROR_COOLDOWN_SECONDS, 15) * 1000,
    maxAttempts: 3,
    baseDelayMs: 500,
    maxOutputTokens: num(env.AI_MAX_OUTPUT_TOKENS, 1024),
    maxHistoryMessages: num(env.AI_MAX_HISTORY_MESSAGES, 8),
  };
}

/** Token saving: keep only the last N messages. */
export function limitHistory<T>(messages: T[], max: number): T[] {
  return messages.length > max ? messages.slice(-max) : messages;
}

// ---------------------------------------------------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------------------------------------------------
type FailureKind =
  | 'rate_limit' // 429: this KEY is out of quota -> cool it down, try the provider's next key
  | 'auth' //       401/403: this KEY is bad -> long cooldown, try the provider's next key
  | 'blocked' //    418 (e.g. NetFree): the whole PROVIDER is unreachable from here -> pause all its keys, next provider
  | 'server' //     5xx: the PROVIDER is struggling -> switch to the next provider immediately
  | 'transient' //  network / timeout: retry the same key with exponential backoff
  | 'other'; //     400/404/empty answer...: this provider cannot answer -> next provider

export class EmptyStreamError extends Error {
  constructor() {
    super('model produced no content');
    this.name = 'EmptyStreamError';
  }
}

export class AllProvidersFailedError extends Error {
  constructor() {
    super('all_providers_failed');
    this.name = 'AllProvidersFailedError';
  }
}

const statusOf = (err: unknown): number | undefined =>
  APICallError.isInstance(err) ? err.statusCode : (err as { statusCode?: number } | null)?.statusCode;

export function classifyFailure(err: unknown): { kind: FailureKind; retryAfterMs?: number } {
  const status = statusOf(err);
  if (status === 429) {
    const header = APICallError.isInstance(err) ? err.responseHeaders?.['retry-after'] : undefined;
    const secs = Number(header);
    return { kind: 'rate_limit', retryAfterMs: Number.isFinite(secs) && secs > 0 ? secs * 1000 : undefined };
  }
  if (status === 418) return { kind: 'blocked' };
  if (status === 401 || status === 403) return { kind: 'auth' };
  if (status !== undefined && status >= 500) return { kind: 'server' };
  if (status === 408) return { kind: 'transient' };
  if (status === undefined && (APICallError.isInstance(err) || isNetworkError(err))) return { kind: 'transient' };
  return { kind: 'other' };
}

// ---------------------------------------------------------------------------------------------------------------------
// Starting one stream and making sure it really started
// ---------------------------------------------------------------------------------------------------------------------

/**
 * streamText never throws for provider errors: they arrive later as an `error` part inside the stream. To be able to fall
 * back BEFORE the client receives anything, we peek at the stream until the first real content shows up (or an error).
 * Only then is the stream handed to the caller. `fullStream` can be read more than once (the SDK tees it), so peeking
 * does not consume anything the HTTP response needs.
 */
async function startStream(
  model: LanguageModel,
  args: { system?: string; messages: ModelMessage[]; maxOutputTokens: number; abortSignal?: AbortSignal },
): Promise<AiStream> {
  const result = streamText({
    model,
    system: args.system,
    messages: args.messages,
    maxOutputTokens: args.maxOutputTokens,
    maxRetries: 0, // retries are ours (per key, with backoff), not the SDK's
    abortSignal: args.abortSignal,
    onError: () => {}, // errors are handled by the fallback loop; mid-stream ones by the route's onError
  });
  const reader = result.fullStream.getReader();
  try {
    for (;;) {
      const { done, value: part } = await reader.read();
      if (done) throw new EmptyStreamError();
      if (part.type === 'error') throw part.error;
      if (part.type === 'abort') throw new Error('request aborted');
      if (part.type === 'finish') throw new EmptyStreamError(); // finished without ever producing content
      if (part.type === 'text-delta' || part.type === 'reasoning-delta' || part.type === 'tool-call') return result;
    }
  } finally {
    await reader.cancel().catch(() => {}); // we only peeked; the HTTP response reads its own branch
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Usage tracking
// ---------------------------------------------------------------------------------------------------------------------
async function recordUsage(store: KeyStateStore, provider: ProviderId, usage: LanguageModelUsage): Promise<void> {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  await store.addUsage(provider, input, output);
  const total = await store.getUsage(provider);
  console.info(
    `[ai] usage ${provider}: this request in=${input} out=${output}; running total in=${total.inputTokens} out=${total.outputTokens} requests=${total.requests}`,
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// The fallback loop
// ---------------------------------------------------------------------------------------------------------------------
export interface StreamWithFallbackOptions {
  messages: ModelMessage[];
  system?: string;
  abortSignal?: AbortSignal;
  env?: Env;
  store?: KeyStateStore;
  config?: Partial<AiConfig>;
  /** Tests inject fake models here. */
  createModel?: (provider: ProviderId, key: ApiKey) => LanguageModel;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface FallbackStream {
  result: AiStream;
  provider: ProviderId;
  /** Masked id of the key that answered ("…ab12"). */
  key: string;
  modelId: string;
}

/**
 * Walks PROVIDER_ORDER. For each provider:
 *   1. claim the least-recently-used key that is not cooling down (the "used" stamp is written atomically, before the call)
 *   2. 429  -> cool down THAT key only, claim the provider's next LRU key
 *      401/403 -> long cooldown for that key, next key
 *      5xx  -> short cooldown for that key, switch to the NEXT PROVIDER immediately
 *      network/timeout -> retry the same key with exponential backoff, up to maxAttempts, then the next provider
 *      anything else -> next provider
 *   3. no key left -> next provider
 * Throws AllProvidersFailedError when nothing worked. Resolves only once the stream has really started.
 */
export async function streamWithFallback(opts: StreamWithFallbackOptions): Promise<FallbackStream> {
  const env = opts.env ?? process.env;
  const cfg = { ...readConfig(env), ...opts.config };
  const store = opts.store ?? (await getKeyStateStore(env));
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const messages = limitHistory(opts.messages, cfg.maxHistoryMessages);

  const providers = configuredProviders(env);
  if (providers.length === 0) console.error('[ai] no provider has an API key configured');

  for (const provider of providers) {
    const keys = getKeys(provider, env);
    const tried = new Set<string>();

    keyLoop: for (;;) {
      const candidates = keys.filter((k) => !tried.has(k.id));
      const id = await store.claimLeastRecentlyUsed(provider, candidates.map((k) => k.id), now());
      if (id === null) {
        console.warn(`[ai] fallback: ${provider} has no available key (all cooling down or already failed); trying next provider`);
        break;
      }
      tried.add(id);
      const key = keys.find((k) => k.id === id)!;
      const { model, modelId } = opts.createModel ? { model: opts.createModel(provider, key), modelId: 'custom' } : buildModel(provider, key, env);

      for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
        try {
          const result = await startStream(model, { system: opts.system, messages, maxOutputTokens: cfg.maxOutputTokens, abortSignal: opts.abortSignal });
          console.info(`[ai] ${provider} (${modelId}, key ${key.mask}) answered${attempt > 1 ? ` on attempt ${attempt}` : ''}`);
          Promise.resolve(result.totalUsage)
            .then((u) => recordUsage(store, provider, u))
            .catch(() => {}); // usage is best-effort; never affects the response
          return { result, provider, key: key.mask, modelId };
        } catch (err) {
          if (opts.abortSignal?.aborted) throw err; // the user left; do not burn through the other providers
          const failure = classifyFailure(err);
          const why = `${failure.kind} (status ${statusOf(err) ?? 'n/a'}): ${describeError(err)}`;

          if (failure.kind === 'rate_limit') {
            const wait = failure.retryAfterMs ?? cfg.rateLimitCooldownMs;
            await store.setCooldown(provider, id, now() + wait);
            console.warn(`[ai] fallback: ${provider} key ${key.mask} rate limited, cooling down ${Math.round(wait / 1000)}s; trying the next ${provider} key`);
            continue keyLoop;
          }
          if (failure.kind === 'auth') {
            await store.setCooldown(provider, id, now() + cfg.authCooldownMs);
            console.error(`[ai] fallback: ${provider} key ${key.mask} rejected (${why}); trying the next ${provider} key`);
            continue keyLoop;
          }
          if (failure.kind === 'blocked') {
            for (const k of keys) await store.setCooldown(provider, k.id, now() + cfg.authCooldownMs);
            console.error(`[ai] fallback: ${provider} is blocked (${why}); pausing it for ${Math.round(cfg.authCooldownMs / 60000)} min; switching provider`);
            break keyLoop;
          }
          if (failure.kind === 'server') {
            await store.setCooldown(provider, id, now() + cfg.serverErrorCooldownMs);
            console.warn(`[ai] fallback: ${provider} server error (${why}); switching provider`);
            break keyLoop;
          }
          if (failure.kind === 'transient' && attempt < cfg.maxAttempts) {
            const delay = cfg.baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * cfg.baseDelayMs * 0.2);
            console.warn(`[ai] ${provider} key ${key.mask} transient error (${why}); retry ${attempt}/${cfg.maxAttempts - 1} in ${delay}ms`);
            await sleep(delay);
            continue;
          }
          console.warn(`[ai] fallback: ${provider} failed (${why}); switching provider`);
          break keyLoop;
        }
      }
    }
  }

  console.error(`[ai] all_providers_failed (tried: ${providers.join(', ') || 'none'})`);
  throw new AllProvidersFailedError();
}
