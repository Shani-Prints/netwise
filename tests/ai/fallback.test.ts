import { APICallError, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AllProvidersFailedError, classifyFailure, limitHistory, streamWithFallback } from '../../src/lib/ai/fallback';
import { MemoryKeyStateStore } from '../../src/lib/ai/store';
import { buildModel, configuredProviders, getKeys, PROVIDER_ORDER } from '../../src/lib/ai/providers';

const apiError = (statusCode?: number, headers?: Record<string, string>) =>
  new APICallError({ message: 'x', url: 'https://example.test', requestBodyValues: {}, statusCode, responseHeaders: headers });

const ok = (text = 'hi') =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: text },
          { type: 'text-end', id: '1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: { inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
          },
        ],
      }),
    }),
  } as never);
const failing = (err: unknown) => new MockLanguageModelV4({ doStream: async () => { throw err; } } as never);

const env = { GEMINI_API_KEYS: 'gem-key-AAAA,gem-key-BBBB', MISTRAL_API_KEYS: 'mis-key-CCCC,mis-key-EEEE', GROQ_API_KEY: 'groq-key-FFFF', OPENROUTER_API_KEY: 'or-key-DDDD' };
const msgs = [{ role: 'user' as const, content: 'hello' }];
const base = { messages: msgs, env, sleep: async () => {}, config: { baseDelayMs: 1 } };

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('keys', () => {
  it('parses lists, dedupes and masks', () => {
    const keys = getKeys('gemini', { GEMINI_API_KEYS: 'a1234, b5678 ,a1234', GEMINI_API_KEY: 'c9999' });
    expect(keys.map((k) => k.mask)).toEqual(['…1234', '…5678', '…9999']);
  });
});

describe('classifyFailure', () => {
  it('maps statuses', () => {
    expect(classifyFailure(apiError(429, { 'retry-after': '30' }))).toEqual({ kind: 'rate_limit', retryAfterMs: 30000 });
    expect(classifyFailure(apiError(401)).kind).toBe('auth');
    expect(classifyFailure(apiError(503)).kind).toBe('server');
    expect(classifyFailure(apiError(undefined)).kind).toBe('transient');
    expect(classifyFailure(apiError(400)).kind).toBe('other');
  });
});

describe('limitHistory', () => {
  it('keeps the last N', () => expect(limitHistory([1, 2, 3, 4], 2)).toEqual([3, 4]));
});

describe('streamWithFallback', () => {
  it('uses the first provider and rotates keys least-recently-used', async () => {
    const store = new MemoryKeyStateStore();
    const used: string[] = [];
    const createModel = (_p: string, key: { mask: string }) => (used.push(key.mask), ok());
    let t = 1000;
    const now = () => t++;
    for (let i = 0; i < 3; i++) await streamWithFallback({ ...base, store, createModel, now });
    expect(used).toEqual(['…AAAA', '…BBBB', '…AAAA']);
  });

  it('429 cools down only that key and tries the provider next key', async () => {
    const store = new MemoryKeyStateStore();
    const providers: string[] = [];
    const createModel = (p: string, key: { mask: string }) => {
      providers.push(`${p}${key.mask}`);
      return key.mask === '…AAAA' ? failing(apiError(429)) : ok();
    };
    const r = await streamWithFallback({ ...base, store, createModel, now: () => 1000 });
    expect(providers).toEqual(['gemini…AAAA', 'gemini…BBBB']);
    expect(r.provider).toBe('gemini');
    // key A is now cooling down: the next request skips it
    providers.length = 0;
    await streamWithFallback({ ...base, store, createModel, now: () => 2000 });
    expect(providers).toEqual(['gemini…BBBB']);
  });

  it('moves to the next provider when all keys are exhausted', async () => {
    const createModel = (p: string) => (p === 'gemini' ? failing(apiError(429)) : ok());
    const r = await streamWithFallback({ ...base, store: new MemoryKeyStateStore(), createModel, now: () => 1000 });
    expect(r.provider).toBe('mistral');
  });

  it('5xx switches provider immediately without trying the other key', async () => {
    const calls: string[] = [];
    const createModel = (p: string, key: { mask: string }) => (calls.push(p + key.mask), p === 'gemini' ? failing(apiError(503)) : ok());
    const r = await streamWithFallback({ ...base, store: new MemoryKeyStateStore(), createModel, now: () => 1000 });
    expect(calls).toEqual(['gemini…AAAA', 'mistral…CCCC']);
    expect(r.provider).toBe('mistral');
  });

  it('retries transient errors up to 3 attempts on the same key', async () => {
    let n = 0;
    const flaky = new MockLanguageModelV4({
      doStream: async () => {
        if (++n < 3) throw apiError(undefined);
        return (await ok().doStream({} as never)) as never;
      },
    } as never);
    const r = await streamWithFallback({ ...base, store: new MemoryKeyStateStore(), createModel: () => flaky, now: () => 1000 });
    expect(n).toBe(3);
    expect(r.provider).toBe('gemini');
  });

  it('reports usage per provider', async () => {
    const store = new MemoryKeyStateStore();
    const r = await streamWithFallback({ ...base, store, createModel: () => ok(), now: () => 1000 });
    await r.result.consumeStream();
    await vi.waitFor(async () => expect(await store.getUsage('gemini')).toEqual({ inputTokens: 3, outputTokens: 5, requests: 1 }));
  });

  it('throws AllProvidersFailedError when nothing works', async () => {
    await expect(
      streamWithFallback({ ...base, store: new MemoryKeyStateStore(), createModel: () => failing(apiError(429)), now: () => 1000 }),
    ).rejects.toBeInstanceOf(AllProvidersFailedError);
  });

  it('never logs a full key', async () => {
    const spy = vi.spyOn(console, 'warn');
    await streamWithFallback({ ...base, store: new MemoryKeyStateStore(), createModel: (p) => (p === 'gemini' ? failing(apiError(429)) : ok()), now: () => 1000 });
    expect(JSON.stringify(spy.mock.calls)).not.toContain('gem-key');
  });
});

describe('MemoryKeyStateStore.claimLeastRecentlyUsed', () => {
  it('concurrent claims never return the same key', async () => {
    const s = new MemoryKeyStateStore();
    const [a, b] = await Promise.all([s.claimLeastRecentlyUsed('p', ['x', 'y'], 1), s.claimLeastRecentlyUsed('p', ['x', 'y'], 1)]);
    expect(new Set([a, b]).size).toBe(2);
  });
});

describe('provider order and AI_DISABLED_PROVIDERS', () => {
  it('default order is gemini -> mistral -> openrouter, groq is configured but not in it', () => {
    expect(PROVIDER_ORDER).toEqual(['gemini', 'mistral', 'openrouter']);
    expect(configuredProviders(env)).toEqual(['gemini', 'mistral', 'openrouter']); // GROQ_API_KEY is set but groq is not used
  });

  it('AI_DISABLED_PROVIDERS removes any provider without code changes', () => {
    expect(configuredProviders({ ...env, AI_DISABLED_PROVIDERS: 'mistral' })).toEqual(['gemini', 'openrouter']);
    expect(configuredProviders({ ...env, AI_DISABLED_PROVIDERS: ' Gemini , openrouter ' })).toEqual(['mistral']);
  });

  it('groq is easy to re-enable via LLM_PROVIDER_ORDER, and AI_DISABLED_PROVIDERS=groq turns it off again', () => {
    const on = { ...env, LLM_PROVIDER_ORDER: 'gemini,groq,mistral' };
    expect(configuredProviders(on)).toEqual(['gemini', 'groq', 'mistral']);
    expect(configuredProviders({ ...on, AI_DISABLED_PROVIDERS: 'groq' })).toEqual(['gemini', 'mistral']);
  });

  it('a disabled provider is never called', async () => {
    const calls: string[] = [];
    const createModel = (p: string) => (calls.push(p), p === 'gemini' ? failing(apiError(503)) : ok());
    const r = await streamWithFallback({ ...base, env: { ...env, AI_DISABLED_PROVIDERS: 'mistral' }, store: new MemoryKeyStateStore(), createModel, now: () => 1 });
    expect(r.provider).toBe('openrouter');
    expect(calls).toEqual(['gemini', 'openrouter']);
  });
});

describe('mistral', () => {
  it('reads MISTRAL_API_KEYS and MISTRAL_API_KEY, uses mistral-small-latest unless MISTRAL_MODEL is set', () => {
    expect(getKeys('mistral', { MISTRAL_API_KEYS: 'a1111,b2222', MISTRAL_API_KEY: 'c3333' }).map((k) => k.mask)).toEqual(['…1111', '…2222', '…3333']);
    const key = getKeys('mistral', env)[0]!;
    expect(buildModel('mistral', key, {}).modelId).toBe('mistral-small-latest');
    expect(buildModel('mistral', key, { MISTRAL_MODEL: 'mistral-large-latest' }).modelId).toBe('mistral-large-latest');
  });

  it('rotates its keys least-recently-used, and a 429 cools down only the failing mistral key', async () => {
    const store = new MemoryKeyStateStore();
    const env2 = { ...env, AI_DISABLED_PROVIDERS: 'gemini' };
    const used: string[] = [];
    let t = 1;
    const createModel = (_p: string, key: { mask: string }) => (used.push(key.mask), ok());
    for (let i = 0; i < 3; i++) await streamWithFallback({ ...base, env: env2, store, createModel, now: () => t++ });
    expect(used).toEqual(['…CCCC', '…EEEE', '…CCCC']);

    used.length = 0;
    const createModel2 = (_p: string, key: { mask: string }) => (used.push(key.mask), key.mask === '…CCCC' ? failing(apiError(429)) : ok());
    const r = await streamWithFallback({ ...base, env: env2, store: new MemoryKeyStateStore(), createModel: createModel2, now: () => 1 });
    expect(used).toEqual(['…CCCC', '…EEEE']);
    expect(r.provider).toBe('mistral');
  });
});

describe('418 and 5xx', () => {
  it('418 pauses ALL keys of that provider for an hour and moves on without trying its other keys', async () => {
    const store = new MemoryKeyStateStore();
    const calls: string[] = [];
    let t = 1000;
    const createModel = (p: string, key: { mask: string }) => (calls.push(p + key.mask), p === 'gemini' ? failing(apiError(418)) : ok());
    const r = await streamWithFallback({ ...base, store, createModel, now: () => t });
    expect(r.provider).toBe('mistral');
    expect(calls).toEqual(['gemini…AAAA', 'mistral…CCCC']); // gemini key B was not tried

    calls.length = 0;
    t += 59 * 60_000;
    await streamWithFallback({ ...base, store, createModel, now: () => t });
    expect(calls.some((c) => c.startsWith('gemini'))).toBe(false); // still paused

    calls.length = 0;
    t += 2 * 60_000;
    await streamWithFallback({ ...base, store, createModel, now: () => t });
    expect(calls[0]).toMatch(/^gemini/); // gemini is tried again after the hour (LRU: the never-used key B first)
  });

  it('503 falls back immediately: one call, no backoff sleep, no second key', async () => {
    const sleeps: number[] = [];
    const calls: string[] = [];
    const createModel = (p: string, key: { mask: string }) => (calls.push(p + key.mask), p === 'gemini' ? failing(apiError(503)) : ok());
    const r = await streamWithFallback({ ...base, sleep: async (ms) => void sleeps.push(ms), store: new MemoryKeyStateStore(), createModel, now: () => 1 });
    expect(r.provider).toBe('mistral');
    expect(calls).toEqual(['gemini…AAAA', 'mistral…CCCC']);
    expect(sleeps).toEqual([]);
  });

  it('only network errors and timeouts back off and retry', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const flaky = new MockLanguageModelV4({ doStream: async () => { n++; throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); } } as never);
    const createModel = (p: string) => (p === 'gemini' ? flaky : ok());
    const r = await streamWithFallback({ ...base, sleep: async (ms) => void sleeps.push(ms), store: new MemoryKeyStateStore(), createModel, now: () => 1 });
    expect(n).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(r.provider).toBe('mistral');
  });
});
