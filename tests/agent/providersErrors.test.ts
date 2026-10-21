import { AISDKError, APICallError, NoContentGeneratedError } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetChatRateLimit } from '../../src/agent/chatHandler';
import { AllProvidersFailedError, BUSY_MESSAGE_HE, classifyError, isRetryable, resetProviderPauses, withFallback, type ProviderEntry } from '../../src/agent/providers';
import { freshRepo, restoreEnv, setupEnv } from '../api/harness';
import { captureConsole, chat, failWith, fake, fast, groupGimelEmployee, provider, say } from './fakes';

const apiError = (statusCode?: number) =>
  new APICallError({ message: 'x', url: 'https://example.test', requestBodyValues: {}, ...(statusCode === undefined ? {} : { statusCode }) });

let con: ReturnType<typeof captureConsole>;
beforeEach(() => {
  setupEnv();
  freshRepo();
  resetChatRateLimit();
  con = captureConsole();
});
afterEach(() => {
  con.restore();
  restoreEnv();
  vi.restoreAllMocks();
});

describe('classifyError: provider/network errors are retried or skipped, anything else is a bug', () => {
  it('HTTP statuses', () => {
    expect(classifyError(apiError(408))).toBe('retryable'); // timeout: the only status worth retrying
    for (const s of [429, 500, 502, 503, 400, 401, 403, 404, 418]) expect(classifyError(apiError(s)), String(s)).toBe('provider');
    expect(classifyError(apiError())).toBe('retryable'); // no HTTP response at all
    expect(classifyError({ statusCode: 503 })).toBe('provider');
    expect(classifyError({ statusCode: 401 })).toBe('provider');
  });

  it('network errors, timeouts and aborts are retryable (also when wrapped in a cause)', () => {
    expect(classifyError(new TypeError('fetch failed'))).toBe('retryable');
    expect(classifyError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe('retryable');
    expect(classifyError(Object.assign(new Error('x'), { code: 'UND_ERR_CONNECT_TIMEOUT' }))).toBe('retryable');
    expect(classifyError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('retryable');
    expect(classifyError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('retryable');
    expect(classifyError(new Error('wrapper', { cause: Object.assign(new Error('y'), { code: 'ETIMEDOUT' }) }))).toBe('retryable');
  });

  it('malformed or empty model output is a provider problem: skip to the next provider, no retry', () => {
    expect(classifyError(new NoContentGeneratedError({}))).toBe('provider');
    expect(classifyError(new AISDKError({ name: 'AI_Something', message: 'm' }))).toBe('provider');
  });

  it('a code bug is a bug', () => {
    expect(classifyError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe('bug');
    expect(classifyError(new RangeError('boom'))).toBe('bug');
    expect(classifyError(new Error('boom'))).toBe('bug');
    expect(classifyError('a string')).toBe('bug');
    expect(classifyError(undefined)).toBe('bug');
  });

  it('isRetryable keeps its old meaning for provider errors', () => {
    expect(isRetryable(apiError(429))).toBe(false);
    expect(isRetryable(apiError(503))).toBe(false);
    expect(isRetryable(apiError(408))).toBe(true);
    expect(isRetryable(apiError(401))).toBe(false);
    expect(isRetryable(new Error('boom'))).toBe(false); // used to be true: that is the bug being fixed
  });
});

describe('withFallback', () => {
  const entry = (name: string): ProviderEntry => ({ name, model: undefined as never });

  it('a bug is rethrown at once: no retry, no next provider, logged as an internal error', async () => {
    const attempt = vi.fn(async () => {
      throw new TypeError('bug base=18500');
    });
    await expect(withFallback([entry('gemini'), entry('groq')], attempt, fast)).rejects.toThrow(TypeError);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(con.lines.error).toEqual(['[netwise] provider gemini failed with an internal error (TypeError); not retried']);
    expect(con.all().join('\n')).not.toMatch(/18500|all_providers_failed/);
  });

  it('network errors / timeouts are retried with the configured count, then the next provider answers', async () => {
    const calls: string[] = [];
    const attempt = async (p: ProviderEntry) => {
      calls.push(p.name);
      if (p.name === 'gemini') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      return 'ok';
    };
    const r = await withFallback([entry('gemini'), entry('groq')], attempt, fast);
    expect(r).toEqual({ value: 'ok', provider: 'groq' });
    expect(calls).toEqual(['gemini', 'gemini', 'gemini', 'groq']); // 1 try + 2 retries, then the next provider
  });

  it('503 "high demand" switches provider immediately: no retry, and no other key of the same provider', async () => {
    const calls: string[] = [];
    const attempt = async (p: ProviderEntry) => {
      calls.push(`${p.name}:${p.keyId}`);
      if (p.name === 'gemini') throw apiError(503);
      return 'ok';
    };
    const keyed = (name: string, keyId: string): ProviderEntry => ({ name, model: undefined as never, keyId });
    const r = await withFallback([keyed('gemini', 'k1'), keyed('gemini', 'k2'), keyed('mistral', 'm1')], attempt, fast);
    expect(r.provider).toBe('mistral');
    expect(calls).toEqual(['gemini:k1', 'mistral:m1']);
  });

  it('429 pauses only that key: the next key of the provider is tried now and the exhausted key is skipped next time', async () => {
    resetProviderPauses();
    const calls: string[] = [];
    const attempt = async (p: ProviderEntry) => {
      calls.push(p.keyId!);
      if (p.keyId === 'k1') throw apiError(429);
      return 'ok';
    };
    const keyed = (name: string, keyId: string): ProviderEntry => ({ name, model: undefined as never, keyId });
    const list = [keyed('gemini', 'k1'), keyed('gemini', 'k2'), keyed('mistral', 'm1')];
    expect((await withFallback(list, attempt, fast)).provider).toBe('gemini');
    expect((await withFallback(list, attempt, fast)).provider).toBe('gemini');
    expect(calls).toEqual(['k1', 'k2', 'k2']); // k1 is paused for the second request
    resetProviderPauses();
  });

  it('418 (blocked network) pauses the whole provider for an hour', async () => {
    resetProviderPauses();
    let t = 0;
    const calls: string[] = [];
    const attempt = async (p: ProviderEntry) => {
      calls.push(`${p.name}:${p.keyId}`);
      if (p.name === 'groq') throw apiError(418);
      return 'ok';
    };
    const keyed = (name: string, keyId: string): ProviderEntry => ({ name, model: undefined as never, keyId });
    const list = [keyed('groq', 'g1'), keyed('groq', 'g2'), keyed('mistral', 'm1')];
    const opts = { ...fast, now: () => t };
    expect((await withFallback(list, attempt, opts)).provider).toBe('mistral');
    expect(calls).toEqual(['groq:g1', 'mistral:m1']); // g2 not tried either
    calls.length = 0;
    t = 59 * 60_000;
    await withFallback(list, attempt, opts);
    expect(calls).toEqual(['mistral:m1']); // still paused 59 minutes later
    calls.length = 0;
    t = 61 * 60_000;
    await withFallback(list, attempt, opts);
    expect(calls[0]).toBe('groq:g1'); // tried again after the hour
    resetProviderPauses();
  });

  it('a provider error that is not retryable (bad key) skips to the next provider without retrying', async () => {
    const calls: string[] = [];
    const attempt = async (p: ProviderEntry) => {
      calls.push(p.name);
      if (p.name === 'gemini') throw apiError(401);
      return 'ok';
    };
    await withFallback([entry('gemini'), entry('groq')], attempt, fast);
    expect(calls).toEqual(['gemini', 'groq']);
  });

  it('when EVERY provider fails: exactly one summary line with the reason code and the provider names', async () => {
    const attempt = async () => {
      throw apiError(503);
    };
    await expect(withFallback([entry('gemini'), entry('groq'), entry('openrouter')], attempt, fast)).rejects.toThrow(AllProvidersFailedError);
    const summary = con.lines.error.filter((l) => l.includes('all_providers_failed'));
    expect(summary).toEqual(['[netwise] chat: all_providers_failed (tried: gemini, groq, openrouter)']);
    expect(con.lines.error.filter((l) => l.includes('failed (status 503'))).toHaveLength(3); // 3 providers x 1 try (no retries)
  });
});

describe('POST /api/chat with failing providers', () => {
  it('a code bug surfaces as an error (500 + error log), NOT as "busy", and is not retried', async () => {
    const e = await groupGimelEmployee();
    const model = failWith(() => new TypeError('code bug with base=18500'));
    const r = await chat(e, 'שלום', { providers: [provider(model, 'gemini'), provider(fake(say('לא אמור להגיע לכאן')), 'groq')] });
    expect(r.status).toBe(500);
    expect(r.body.error).not.toBe(BUSY_MESSAGE_HE);
    expect(model.doGenerateCalls).toHaveLength(1);
    const all = con.all().join('\n');
    expect(all).toContain('[netwise] provider gemini failed with an internal error (TypeError); not retried');
    expect(all).toContain('[netwise] chat error: TypeError');
    expect(all).not.toContain('all_providers_failed');
    expect(all).not.toMatch(/18500|code bug/);
    // the employee's message was saved before the failure
    expect((await e.state()).body.messages.map((m: { role: string }) => m.role)).toEqual(['user']);
  });

  it('a network error is retried, then the next provider answers', async () => {
    const e = await groupGimelEmployee();
    const a = failWith(() => new TypeError('fetch failed'));
    const r = await chat(e, 'שלום', { providers: [provider(a, 'gemini'), provider(fake(say('שלום מהספק השני')), 'groq')] });
    expect(r.status).toBe(200);
    expect(r.body.assistantText).toBe('שלום מהספק השני');
    expect(a.doGenerateCalls).toHaveLength(3);
  });

  it('empty or malformed model output moves to the next provider without retrying the same one', async () => {
    const e = await groupGimelEmployee();
    const a = failWith(() => new NoContentGeneratedError({}));
    const r = await chat(e, 'שלום', { providers: [provider(a, 'gemini'), provider(fake(say('בסדר')), 'groq')] });
    expect(r.body.assistantText).toBe('בסדר');
    expect(a.doGenerateCalls).toHaveLength(1);
  });

  it('every provider failing: 503 with the Hebrew busy message and ONE all_providers_failed line', async () => {
    const e = await groupGimelEmployee();
    const r = await chat(e, 'שלום', {
      providers: [provider(failWith(() => apiError(429)), 'gemini'), provider(failWith(() => apiError(500)), 'groq')],
    });
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: BUSY_MESSAGE_HE });
    expect(con.lines.error.filter((l) => l.includes('all_providers_failed'))).toEqual(['[netwise] chat: all_providers_failed (tried: gemini, groq)']);
  });

  it('no provider key configured: 503 and ONE no_provider_configured line, no key or variable value in it', async () => {
    const e = await groupGimelEmployee();
    const r = await chat(e, 'שלום', { env: {} });
    expect(r.status).toBe(503);
    expect(con.lines.error).toEqual(['[netwise] chat: no_provider_configured']);
  });
});
