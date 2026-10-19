import { describe, expect, it } from 'vitest';
import { createChatStore, displayMessages } from '../../src/components/car-advisor/chatStore';
import { ApiError, type AdvisorApiClient } from '../../src/components/car-advisor/contract/apiClient';
import type { ApiEmployeeState, ApiMessage } from '../../src/components/car-advisor/contract/apiTypes';

const msg = (id: string, role: ApiMessage['role'], content: string): ApiMessage => ({ id, role, content, createdAt: '2026-01-01T00:00:00Z' });
const state = (messages: ApiMessage[], extra: Partial<ApiEmployeeState> = {}): ApiEmployeeState =>
  ({
    messages,
    profile: {},
    alternative: null,
    comparison: null,
    todayOnly: { status: 'missing', missingFields: [], missingText: [] },
    escalation: { needsReference: false },
    questions: [],
    awaitingRepresentative: false,
    repAnswers: {},
    updates: { newAnswers: false, updatedFields: [] },
    ...extra,
  }) as unknown as ApiEmployeeState;

/** A promise that the test resolves by hand, to decide in which order the server's answers arrive. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

const FIRST = 'מה יקרה לנטו שלי אם אעבור לקיה נירו?';
const texts = (s: ReturnType<typeof createChatStore>) => displayMessages(s.getState()).map((m) => `${m.role}:${m.content}`);

describe('item 2: each message appears once', () => {
  it('REPRO: the first read of the window (started before the message) lands AFTER the server stored it - one bubble, not two', async () => {
    const firstRead = deferred<ApiEmployeeState>();
    const chat = deferred<{ assistantText: string }>();
    const calls: string[] = [];
    let stored = false;
    const api = {
      ensureSession: async () => {},
      getState: () => {
        calls.push('state');
        // the 1st read is slow (cold start); every later read is answered at once
        return calls.length === 1 ? firstRead.promise : Promise.resolve(state(stored ? [msg('1', 'user', FIRST), msg('2', 'assistant', 'תשובה')] : []));
      },
      sendMessage: async () => {
        stored = true; // the server stores the user's message first, then the model works for a while
        return chat.promise;
      },
    } as unknown as AdvisorApiClient;
    const store = createChatStore(api);
    const loading = store.load(); // window opened: session, then the slow first read
    await Promise.resolve();
    store.setDraft(FIRST);
    const sending = store.submit();
    expect(texts(store)).toEqual([`user:${FIRST}`]); // optimistic bubble
    // the slow first read finally returns, and by now the server already has the user's message (but not the answer)
    firstRead.resolve(state([msg('1', 'user', FIRST)]));
    await loading;
    expect(texts(store)).toEqual([`user:${FIRST}`]); // used to be two bubbles until the whole turn finished
    chat.resolve({ assistantText: 'תשובה' });
    await sending;
    expect(texts(store)).toEqual([`user:${FIRST}`, 'assistant:תשובה']);
    expect(store.getState().pending).toBeNull();
  });

  it('a read that was started before a newer one and arrives later does not replace the newer conversation', async () => {
    const slow = deferred<ApiEmployeeState>();
    let n = 0;
    const api = {
      ensureSession: async () => {},
      getState: () => (++n === 1 ? slow.promise : Promise.resolve(state([msg('1', 'user', 'א'), msg('2', 'assistant', 'ב')]))),
    } as unknown as AdvisorApiClient;
    const store = createChatStore(api);
    const old = store.refresh();
    await store.refresh();
    expect(texts(store)).toEqual(['user:א', 'assistant:ב']);
    slow.resolve(state([])); // the older read lands last
    await old;
    expect(texts(store)).toEqual(['user:א', 'assistant:ב']);
  });

  it('the same text sent twice on purpose is two bubbles (the baseline counts what the server already had)', async () => {
    const stored: ApiMessage[] = [];
    const api = {
      ensureSession: async () => {},
      getState: async () => state([...stored]),
      sendMessage: async (text: string) => {
        stored.push(msg(`u${stored.length}`, 'user', text), msg(`a${stored.length}`, 'assistant', 'ok'));
        return { assistantText: 'ok' };
      },
    } as unknown as AdvisorApiClient;
    const store = createChatStore(api);
    store.setDraft('שלום');
    await store.submit();
    store.setDraft('שלום');
    await store.submit();
    expect(texts(store).filter((t) => t === 'user:שלום')).toHaveLength(2);
  });

  it('a second submit while one is running is ignored (no double send)', async () => {
    let sends = 0;
    const gate = deferred<{ assistantText: string }>();
    const api = {
      ensureSession: async () => {},
      getState: async () => state([]),
      sendMessage: () => ((sends += 1), gate.promise),
    } as unknown as AdvisorApiClient;
    const store = createChatStore(api);
    store.setDraft('שלום');
    const first = store.submit();
    store.setDraft('שלום');
    await store.submit(); // double click / Enter twice
    gate.resolve({ assistantText: 'ok' });
    await first;
    expect(sends).toBe(1);
  });

  it('no connection and the message never arrived: the text goes back into the composer; if it did arrive it is not put back', async () => {
    for (const arrived of [false, true]) {
      const api = {
        ensureSession: async () => {},
        getState: async () => state(arrived ? [msg('1', 'user', 'שלום')] : []),
        sendMessage: async () => {
          throw new ApiError(0, 'network');
        },
      } as unknown as AdvisorApiClient;
      const store = createChatStore(api);
      store.setDraft('שלום');
      await store.submit();
      expect(store.getState().draft, `arrived=${arrived}`).toBe(arrived ? '' : 'שלום');
      expect(store.getState().error).toBeTruthy();
    }
  });

  it('a rejected message (400/401/403/429) goes back into the composer', async () => {
    const api = {
      ensureSession: async () => {},
      getState: async () => state([]),
      sendMessage: async () => {
        throw new ApiError(429, 'rate');
      },
    } as unknown as AdvisorApiClient;
    const store = createChatStore(api);
    store.setDraft('שלום');
    await store.submit();
    expect(store.getState().draft).toBe('שלום');
  });
});

describe('the store keeps only the open questions (answered ones are not shown)', () => {
  it('questions: only open ones; awaiting follows the server', async () => {
    const q = (id: string, status: 'open' | 'answered') => ({ id, kind: 'profile_field_unknown', field: 'x', label: 'ל', status, createdAt: '', answeredAt: null });
    const api = {
      ensureSession: async () => {},
      getState: async () => state([], { questions: [q('1', 'open'), q('2', 'answered')], awaitingRepresentative: true } as never),
    } as unknown as AdvisorApiClient;
    const store = createChatStore(api);
    await store.load();
    expect(store.getState().questions.map((x) => x.id)).toEqual(['1']);
  });
});
