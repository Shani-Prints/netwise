import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fill } from '../../src/components/car-advisor/content/fill';
import { he } from '../../src/components/car-advisor/content/he';
import {
  ApiError,
  createApiClient,
  describeApiError,
  MAX_CHAT_CHARS,
  MAX_REP_TEXT_CHARS,
} from '../../src/components/car-advisor/contract/apiClient';
import { createPoller } from '../../src/components/car-advisor/contract/poller';
import { EMPLOYEE_POLL_MS, shouldPollEmployee } from '../../src/components/car-advisor/contract/pollPolicy';

// ---- a fake fetch: every call is recorded, answers come from a queue of [status, body] ----
type Reply = [number, unknown];
function fakeFetch(replies: (Reply | Error)[]) {
  const calls: { method: string; path: string; body: unknown; init: RequestInit }[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? 'GET',
      path: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      init: init ?? {},
    });
    const next = replies.shift();
    if (next === undefined) throw new Error(`unexpected request #${calls.length}: ${init?.method} ${String(input)}`);
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next[1]), { status: next[0], headers: { 'content-type': 'application/json' } });
  });
  return { fetch: impl as unknown as typeof fetch, calls, remaining: () => replies.length };
}
const route = (c: { method: string; path: string }) => `${c.method} ${c.path}`;

const CHAT_OK: Reply = [200, { assistantText: 'שלום!' }];

describe('the session comes before the first chat message', () => {
  it('GET /api/session once, then POST /api/chat; the next message does not call the session again', async () => {
    const f = fakeFetch([[200, { role: 'employee', isNew: true }], CHAT_OK, CHAT_OK]);
    const api = createApiClient({ fetch: f.fetch });
    await api.sendMessage('היי');
    await api.sendMessage('עוד הודעה');
    expect(f.calls.map(route)).toEqual(['GET /api/session', 'POST /api/chat', 'POST /api/chat']);
    expect(f.calls[1]!.body).toEqual({ message: 'היי' });
    // same origin, cookies sent, nothing cached, JSON only when there is a body
    for (const c of f.calls) {
      expect(c.init.credentials).toBe('same-origin');
      expect(c.init.cache).toBe('no-store');
    }
    expect((f.calls[1]!.init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(f.calls[0]!.init.headers).toBeUndefined();
  });

  it('many callers at once start ONE session request', async () => {
    const f = fakeFetch([[200, { role: 'employee', isNew: true }]]);
    const api = createApiClient({ fetch: f.fetch });
    await Promise.all([api.ensureSession(), api.ensureSession(), api.ensureSession()]);
    expect(f.calls).toHaveLength(1);
  });

  it('a failed session start is tried again on the next call', async () => {
    const f = fakeFetch([[500, { error: { code: 'internal_error' } }], [200, { role: 'employee', isNew: true }]]);
    const api = createApiClient({ fetch: f.fetch });
    await expect(api.ensureSession()).rejects.toMatchObject({ status: 500 });
    await api.ensureSession();
    expect(f.calls.map(route)).toEqual(['GET /api/session', 'GET /api/session']);
  });

  it('a cookie that cannot be verified (401 on the session) is cleared and a new session is created', async () => {
    const f = fakeFetch([[401, { error: { code: 'unauthorized' } }], [200, { ok: true }], [200, { role: 'employee', isNew: true }], CHAT_OK]);
    const api = createApiClient({ fetch: f.fetch });
    await api.sendMessage('היי');
    expect(f.calls.map(route)).toEqual(['GET /api/session', 'DELETE /api/session', 'GET /api/session', 'POST /api/chat']);
  });
});

describe('a 401 from the chat renews the session and retries ONCE', () => {
  it('chat 401 -> GET /api/session -> chat again -> success', async () => {
    const f = fakeFetch([[200, { role: 'employee', isNew: false }], [401, { error: 'x' }], [200, { role: 'employee', isNew: true }], CHAT_OK]);
    const api = createApiClient({ fetch: f.fetch });
    const reply = await api.sendMessage('היי');
    expect(reply.assistantText).toBe('שלום!');
    expect(f.calls.map(route)).toEqual(['GET /api/session', 'POST /api/chat', 'GET /api/session', 'POST /api/chat']);
    expect(f.calls[3]!.body).toEqual({ message: 'היי' }); // the same message
  });

  it('a second 401 is an error: no third attempt, no loop', async () => {
    const f = fakeFetch([[200, {}], [401, { error: 'x' }], [200, {}], [401, { error: 'x' }]]);
    const api = createApiClient({ fetch: f.fetch });
    await expect(api.sendMessage('היי')).rejects.toMatchObject({ status: 401 });
    expect(f.calls.filter((c) => c.path === '/api/chat')).toHaveLength(2);
    expect(f.remaining()).toBe(0);
  });

  it('the employee state is read the same way', async () => {
    const state = { messages: [], awaitingRepresentative: false, questions: [] };
    const f = fakeFetch([[200, {}], [401, { error: { code: 'unauthorized' } }], [200, {}], [200, state]]);
    const api = createApiClient({ fetch: f.fetch });
    expect(await api.getState()).toEqual(state);
    expect(f.calls.map(route)).toEqual(['GET /api/session', 'GET /api/employee/state', 'GET /api/session', 'GET /api/employee/state']);
  });

  it('other errors are NOT retried', async () => {
    for (const status of [400, 403, 429, 503]) {
      const f = fakeFetch([[200, {}], [status, { error: 'שגיאה' }]]);
      const api = createApiClient({ fetch: f.fetch });
      await expect(api.sendMessage('היי')).rejects.toMatchObject({ status });
      expect(f.calls.filter((c) => c.path === '/api/chat')).toHaveLength(1);
    }
  });
});

describe('client-side checks and network failures', () => {
  it('an empty or too long message never reaches the server', async () => {
    const f = fakeFetch([]);
    const api = createApiClient({ fetch: f.fetch });
    await expect(api.sendMessage('   ')).rejects.toMatchObject({ status: 400, code: 'empty_message' });
    await expect(api.sendMessage('א'.repeat(MAX_CHAT_CHARS + 1))).rejects.toMatchObject({ status: 400, code: 'too_long' });
    await expect(api.repAnswerText('q', 'א'.repeat(MAX_REP_TEXT_CHARS + 1))).rejects.toMatchObject({ code: 'too_long' });
    await expect(api.repAnswerText('q', ' ')).rejects.toMatchObject({ code: 'empty_message' });
    expect(f.calls).toHaveLength(0);
    const f2 = fakeFetch([[200, {}], CHAT_OK]);
    await createApiClient({ fetch: f2.fetch }).sendMessage('א'.repeat(MAX_CHAT_CHARS)); // exactly the limit is fine
  });

  it('no connection is an ApiError with status 0', async () => {
    const f = fakeFetch([new TypeError('Failed to fetch')]);
    await expect(createApiClient({ fetch: f.fetch }).ensureSession()).rejects.toMatchObject({ status: 0, code: 'network' });
  });

  it('a body that is not JSON still gives a clean error', async () => {
    const fetchMock = (async () => new Response('<html>oops</html>', { status: 502 })) as unknown as typeof fetch;
    await expect(createApiClient({ fetch: fetchMock }).repListQuestions()).rejects.toMatchObject({ status: 502, code: 'unknown' });
  });
});

describe('friendly Hebrew messages for every status', () => {
  const e = he.api.errors;
  const err = (status: number, code = 'unknown', serverMessage: string | null = null) => new ApiError(status, code, serverMessage);

  it('chat', () => {
    expect(describeApiError(err(0, 'network'), 'chat')).toBe(e.network);
    expect(describeApiError(err(400, 'server_message', 'ההודעה ארוכה מדי.'), 'chat')).toBe('ההודעה ארוכה מדי.'); // the server's Hebrew
    expect(describeApiError(err(400, 'too_long'), 'chat')).toBe(fill(e.tooLong, { max: '1000' }));
    expect(describeApiError(err(401), 'chat')).toBe(e.session);
    expect(describeApiError(err(403), 'chat')).toBe(e.forbidden);
    expect(describeApiError(err(429, 'server_message', 'x'), 'chat')).toBe(e.rateLimited);
    expect(describeApiError(err(503, 'server_message', 'המערכת עמוסה כרגע.'), 'chat')).toBe('המערכת עמוסה כרגע.');
    expect(describeApiError(err(503), 'chat')).toBe(e.busy);
    expect(describeApiError(err(500), 'chat')).toBe(e.generic);
    expect(describeApiError(new Error('boom'), 'chat')).toBe(e.generic);
  });

  it('representative login', () => {
    expect(describeApiError(err(401, 'invalid_code'), 'repLogin')).toBe(e.wrongCode);
    expect(describeApiError(err(403, 'rep_login_disabled'), 'repLogin')).toBe(e.loginDisabled);
    expect(describeApiError(err(429), 'repLogin')).toBe(e.rateLimited);
    expect(describeApiError(err(400, 'invalid_request'), 'repLogin')).toBe(e.invalid);
  });

  it('representative list and answers: 400 / 401 / 403 / 404 / 409 / 429', () => {
    expect(describeApiError(err(401, 'unauthorized'), 'repList')).toBe(e.needLogin);
    expect(describeApiError(err(403, 'forbidden'), 'repList')).toBe(e.notRep);
    expect(describeApiError(err(400, 'invalid_answer'), 'repAnswer')).toBe(e.invalidAnswer);
    expect(describeApiError(err(400, 'invalid_request'), 'repAnswerText')).toBe(e.invalid);
    expect(describeApiError(err(404, 'question_not_found'), 'repAnswer')).toBe(e.notFound);
    expect(describeApiError(err(409, 'already_answered'), 'repAnswer')).toBe(e.conflict);
    expect(describeApiError(err(409, 'answer_in_progress'), 'repAnswerText')).toBe(e.conflict);
    expect(describeApiError(err(429, 'rate_limited'), 'repAnswerText')).toBe(e.rateLimited);
    expect(describeApiError(err(400, 'too_long'), 'repAnswerText')).toBe(fill(e.tooLong, { max: '500' }));
  });

  it('never shows a status number, a code or a stack', () => {
    for (const status of [0, 400, 401, 403, 404, 409, 429, 500, 503]) {
      const text = describeApiError(err(status, 'some_internal_code'), 'repAnswer');
      expect(text).not.toMatch(/some_internal_code|\b(?:400|401|403|404|409|429|500|503)\b|Error:/);
      expect(text).toMatch(/[א-ת]/);
    }
  });
});

describe('the representative calls', () => {
  it('login sends only the code; the code is never logged and never part of an error', async () => {
    const SECRET = 'rep-secret-code-123';
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const f = fakeFetch([[401, { error: { code: 'invalid_code' } }], [200, { role: 'rep' }]]);
    const api = createApiClient({ fetch: f.fetch });
    const failed = await api.repLogin(SECRET).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(ApiError);
    expect(JSON.stringify(failed) + String((failed as Error).message)).not.toContain(SECRET);
    expect(describeApiError(failed, 'repLogin')).not.toContain(SECRET);
    await api.repLogin(SECRET);
    expect(f.calls.map(route)).toEqual(['POST /api/session/rep', 'POST /api/session/rep']);
    expect(f.calls[0]!.body).toEqual({ code: SECRET });
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
      spy.mockRestore();
    }
  });

  it('list, typed answer and free-text answer use the contract paths and bodies', async () => {
    const q = { id: 'q1', kind: 'profile_field_unknown' };
    const f = fakeFetch([
      [200, { questions: [q] }],
      [200, { question: { ...q, status: 'answered' } }],
      [200, { question: q, interpretation: 'applied' }],
    ]);
    const api = createApiClient({ fetch: f.fetch });
    expect(await api.repListQuestions()).toEqual([q]);
    expect((await api.repAnswerTyped('q1', '2.75')).status).toBe('answered');
    expect((await api.repAnswerText('q1', '  שישה אחוז  ')).interpretation).toBe('applied');
    expect(f.calls.map((c) => [route(c), c.body])).toEqual([
      ['GET /api/rep/questions', undefined],
      ['POST /api/rep/answer', { questionId: 'q1', answer: '2.75' }],
      ['POST /api/rep/answer-text', { questionId: 'q1', text: 'שישה אחוז' }],
    ]);
  });

  it('401 and 403 on the list are reported as they are (the screen then shows the login form)', async () => {
    for (const status of [401, 403]) {
      const f = fakeFetch([[status, { error: { code: 'x' } }]]);
      await expect(createApiClient({ fetch: f.fetch }).repListQuestions()).rejects.toMatchObject({ status });
      expect(f.calls).toHaveLength(1); // the representative screens never create an employee session
    }
  });
});

describe('polling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shouldPollEmployee: only while the window is open, after a message, and while a question is open', () => {
    const base = { active: true, hasSentMessage: true, awaitingRepresentative: true, openQuestions: 1 };
    expect(shouldPollEmployee(base)).toBe(true);
    expect(shouldPollEmployee({ ...base, awaitingRepresentative: false, openQuestions: 0 })).toBe(false); // nothing open
    expect(shouldPollEmployee({ ...base, active: false })).toBe(false); // the widget is closed -> stop
    expect(shouldPollEmployee({ ...base, hasSentMessage: false })).toBe(false); // no message yet
    expect(EMPLOYEE_POLL_MS).toBe(10_000);
  });

  it('ticks every interval, one at a time, and stop() ends it for good', async () => {
    const tick = vi.fn(async () => {});
    const poller = createPoller({ intervalMs: 10_000, tick });
    poller.start();
    poller.start(); // a second start does nothing
    expect(poller.running).toBe(true);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(tick).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(tick).toHaveBeenCalledTimes(3);
    poller.stop();
    expect(poller.running).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).toHaveBeenCalledTimes(3); // nothing after stop
  });

  it('a slow tick never overlaps the next one, and stopping during a tick schedules nothing more', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const poller = createPoller({
      intervalMs: 1_000,
      tick: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5_000));
        inFlight--;
      },
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1_000); // first tick starts and takes 5 s
    await vi.advanceTimersByTimeAsync(4_000);
    expect(maxInFlight).toBe(1);
    poller.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(maxInFlight).toBe(1);
    expect(inFlight).toBe(0);
  });

  it('a failing tick is reported and polling goes on', async () => {
    const errors: unknown[] = [];
    let n = 0;
    const poller = createPoller({
      intervalMs: 1_000,
      tick: () => {
        n++;
        if (n === 1) throw new Error('boom');
      },
      onError: (e) => errors.push(e),
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(n).toBe(3);
    expect(errors).toHaveLength(1);
    poller.stop();
  });
});
