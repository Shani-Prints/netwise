import { createGoogle } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { AISDKError, APICallError, type LanguageModel } from 'ai';

export const BUSY_MESSAGE_HE = 'המערכת עמוסה כרגע ולא הצלחתי לענות. הנתונים ששמרת נשמרו; נסו שוב בעוד רגע.';

export interface ProviderEntry {
  name: string;
  model: LanguageModel;
}

type Env = Record<string, string | undefined>;

// Model ids: gemini-3.8-flash is the id used in the current AI SDK Google docs (and it answered on the live API).
// Groq: openai/gpt-oss-120b is a production model with tool use in both the AI SDK Groq docs and Groq's tool-use docs,
// and it is available to the project key (llama-3.3-70b-versatile is not). NOTE: neither doc states Hebrew support.
// TODO(openrouter): the OpenRouter docs page could not be fetched; set OPENROUTER_MODEL to a verified id.
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';
const DEFAULT_OPENROUTER_MODEL = 'openrouter/free';

const DEFAULT_ORDER = 'gemini,groq,openrouter';

/** Providers in LLM_PROVIDER_ORDER, skipping any whose key is missing. Keys are read from env only. */
export function buildProviders(env: Env = process.env): ProviderEntry[] {
  const order = (env.LLM_PROVIDER_ORDER?.trim() || DEFAULT_ORDER)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const out: ProviderEntry[] = [];
  for (const name of [...new Set(order)]) {
    if (name === 'gemini' && env.GEMINI_API_KEY) {
      out.push({ name, model: createGoogle({ apiKey: env.GEMINI_API_KEY })(env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL) });
    } else if (name === 'groq' && env.GROQ_API_KEY) {
      out.push({ name, model: createGroq({ apiKey: env.GROQ_API_KEY })(env.GROQ_MODEL || DEFAULT_GROQ_MODEL) });
    } else if (name === 'openrouter' && env.OPENROUTER_API_KEY) {
      out.push({
        name,
        model: createOpenRouter({ apiKey: env.OPENROUTER_API_KEY }).chat(env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL),
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
  sleep?: (ms: number) => Promise<void>;
}

const statusOf = (err: unknown): number | undefined =>
  APICallError.isInstance(err) ? err.statusCode : (err as { statusCode?: number } | null)?.statusCode;

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** Timeouts, aborted requests and connection failures (also when wrapped in `cause`). */
function isNetworkError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== 'object' || depth > 3) return false;
  const e = err as { name?: string; code?: string; message?: string; cause?: unknown };
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;
  if (e.code && NETWORK_CODES.has(e.code)) return true;
  if (e.name === 'TypeError' && /fetch failed|network|terminated/i.test(e.message ?? '')) return true;
  return isNetworkError(e.cause, depth + 1);
}

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
 * Runs `attempt` on each provider in order. Retryable failures back off exponentially (few retries), then the next
 * provider is tried. Throws AllProvidersFailedError when none succeeds (after ONE summary log line with the reason code
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
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (const p of providers) {
    for (let i = 0; i <= retries; i++) {
      try {
        const value = await attempt(p);
        console.info(`[netwise] provider ${p.name} answered (try ${i + 1})`);
        return { value, provider: p.name };
      } catch (err) {
        const kind = classifyError(err);
        if (kind === 'bug') {
          console.error(
            `[netwise] provider ${p.name} failed with an internal error (${err instanceof Error ? err.name : 'unknown'}); not retried`,
          );
          throw err;
        }
        console.error(`[netwise] provider ${p.name} failed (status ${statusOf(err) ?? 'n/a'}, try ${i + 1})`);
        if (kind !== 'retryable' || i === retries) break;
        await sleep(base * 2 ** i + Math.floor(Math.random() * base * 0.2));
      }
    }
  }
  console.error(`[netwise] chat: all_providers_failed (tried: ${providers.map((p) => p.name).join(', ') || 'none'})`);
  throw new AllProvidersFailedError();
}
