import { he } from './content/he';
import { ApiError, describeApiError, type AdvisorApiClient } from './contract/apiClient';
import type { ApiCarChoices, ApiComparison, ApiEmployeeQuestion, ApiEmployeeState, ApiMessage, NotificationView } from './contract/types';

/** What the messages area shows: the conversation as the SERVER stores it, plus the message that is being sent. */
export interface DisplayMessage {
  id: string;
  role: ApiMessage['role'];
  content: string;
}

/** The message that is being sent. `baseline` = how many identical user messages the server already had when it was sent. */
export interface PendingMessage {
  text: string;
  baseline: number;
}

export interface ChatState {
  serverMessages: ApiMessage[];
  pending: PendingMessage | null;
  comparison: ApiComparison | null;
  carChoices: ApiCarChoices | null;
  comparisons: { messageId: string; comparison: ApiComparison }[];
  waiverAllowed: boolean;
  questions: ApiEmployeeQuestion[];
  awaiting: boolean;
  draft: string;
  busy: boolean;
  error: string | null;
  sentHere: boolean;
}

export const initialChatState = (): ChatState => ({
  serverMessages: [],
  pending: null,
  comparison: null,
  carChoices: null,
  comparisons: [],
  waiverAllowed: false,
  questions: [],
  awaiting: false,
  draft: '',
  busy: false,
  error: null,
  sentHere: false,
});

/**
 * Errors after which the server certainly did NOT store the message (so the text can go back into the composer):
 * a rejected request, no session, a rate limit. After a 503 or a 500 the message IS stored. After a network failure (status 0)
 * it is unknown - the connection can break after the server stored the message - so it is not restored (the conversation that the
 * server returns shows whether it arrived).
 */
export function messageWasNotStored(error: unknown): boolean {
  return error instanceof ApiError && [400, 401, 403, 429].includes(error.status);
}

export function updateNotification(): NotificationView {
  return { title: he.api.notification.title, body: he.api.notification.body, timeLabel: he.notification.timeNow };
}

const countUser = (messages: ApiMessage[], text: string) => messages.filter((m) => m.role === 'user' && m.content === text).length;

/**
 * The bubbles to show. The message being sent is shown as soon as it is typed; the moment the server's conversation already
 * contains it (a read that lands while the answer is still being prepared) the server's copy is the only one shown, so one
 * message is never two bubbles.
 */
export function displayMessages(state: ChatState): DisplayMessage[] {
  const out: DisplayMessage[] = state.serverMessages.map((m) => ({ id: m.id, role: m.role, content: m.content }));
  const p = state.pending;
  if (p !== null && countUser(state.serverMessages, p.text) <= p.baseline) out.push({ id: 'pending-user', role: 'user', content: p.text });
  return out;
}

export interface ChatStore {
  getState(): ChatState;
  subscribe(listener: () => void): () => void;
  setDraft(value: string): void;
  /** First time the window is shown: session, then the conversation the server already has. */
  load(): Promise<void>;
  /** Reads the conversation. A read that was started earlier than one already applied is ignored. */
  refresh(): Promise<void>;
  submit(): Promise<void>;
  /** Who is told when a representative's answer was applied. */
  setOnUpdate(fn: ((n: NotificationView) => void) | undefined): void;
}

export function createChatStore(api: AdvisorApiClient, initialOnUpdate?: (n: NotificationView) => void): ChatStore {
  let onUpdate = initialOnUpdate;
  let state = initialChatState();
  const listeners = new Set<() => void>();
  const set = (patch: Partial<ChatState>) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  };
  let started = 0;
  let applied = 0;
  let busy = false;

  const apply = (s: ApiEmployeeState) => {
    set({
      serverMessages: s.messages,
      comparison: s.comparison,
      carChoices: s.carChoices ?? null,
      comparisons: s.comparisons ?? [],
      waiverAllowed: s.waiverAllowed === true,
      questions: s.questions.filter((q) => q.status === 'open'),
      awaiting: s.awaitingRepresentative,
    });
    if (s.updates.newAnswers) onUpdate?.(updateNotification());
  };

  const refresh = async () => {
    const id = ++started;
    const s = await api.getState();
    if (id < applied) return; // a newer read was already applied: this one is older than what is on screen
    applied = id;
    apply(s);
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setDraft: (draft) => set({ draft }),
    setOnUpdate(fn) {
      onUpdate = fn;
    },
    refresh,
    async load() {
      try {
        await api.ensureSession();
        await refresh();
      } catch (failure) {
        set({ error: describeApiError(failure, 'state') });
      }
    },
    async submit() {
      const text = state.draft.trim();
      if (!text || busy) return;
      busy = true;
      set({ busy: true, error: null, draft: '', sentHere: true, pending: { text, baseline: countUser(state.serverMessages, text) } });
      let failure: unknown = null;
      try {
        await api.sendMessage(text);
      } catch (caught) {
        failure = caught;
        set({ error: describeApiError(caught, 'chat') });
        if (messageWasNotStored(caught)) set({ draft: state.draft === '' ? text : state.draft });
      }
      let refreshed = false;
      try {
        await refresh(); // the stored conversation (also after a failure: the server may have kept the message)
        refreshed = true;
      } catch (caught) {
        if (failure === null) set({ error: describeApiError(caught, 'state') });
      }
      // no connection: if the conversation that came back does not contain the message, it never arrived - put it back
      if (failure instanceof ApiError && failure.status === 0 && refreshed && countUser(state.serverMessages, text) <= state.pending!.baseline) {
        set({ draft: state.draft === '' ? text : state.draft });
      }
      busy = false;
      set({ pending: null, busy: false });
    },
  };
}
