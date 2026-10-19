import { useCallback, useEffect, useRef, useState } from 'react';
import { he } from './content/he';
import { ApiError, describeApiError, type AdvisorApiClient } from './contract/apiClient';
import { createPoller } from './contract/poller';
import { EMPLOYEE_POLL_MS, shouldPollEmployee } from './contract/pollPolicy';
import type { ApiComparison, ApiEmployeeQuestion, ApiMessage, ApiEmployeeState, NotificationView } from './contract/types';

/** What the messages area shows: the conversation as the SERVER stores it, plus the message that is being sent. */
export interface DisplayMessage {
  id: string;
  role: ApiMessage['role'];
  content: string;
}

/**
 * Errors after which the server certainly did NOT store the message (so the text can go back into the composer):
 * no connection, a rejected request, no session, a rate limit. After a 503 or a 500 the message IS stored.
 */
export function messageWasNotStored(error: unknown): boolean {
  return error instanceof ApiError && [0, 400, 401, 403, 429].includes(error.status);
}

export function updateNotification(): NotificationView {
  return { title: he.api.notification.title, body: he.api.notification.body, timeLabel: he.notification.timeNow };
}

/**
 * Chat state of the REAL widget. The conversation, the comparison and the questions all come from the server
 * (GET /api/employee/state); nothing is persisted in the browser. The server is read once when the window is first opened,
 * after every message, and every ~10 seconds while a question is open and the window is open.
 * `onUpdate` is called when a representative's answer was applied (updates.newAnswers).
 */
export function useApiChatController(
  api: AdvisorApiClient,
  active: boolean,
  onUpdate?: (notification: NotificationView) => void,
) {
  const [serverMessages, setServerMessages] = useState<ApiMessage[]>([]);
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [comparison, setComparison] = useState<ApiComparison | null>(null);
  const [questions, setQuestions] = useState<ApiEmployeeQuestion[]>([]);
  const [awaiting, setAwaiting] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentHere, setSentHere] = useState(false);

  const busyRef = useRef(false);
  const onUpdateRef = useRef(onUpdate);
  useEffect(() => {
    onUpdateRef.current = onUpdate;
  }, [onUpdate]);

  const applyState = useCallback((state: ApiEmployeeState) => {
    setServerMessages(state.messages);
    setComparison(state.comparison);
    setQuestions(state.questions.filter((question) => question.status === 'open'));
    setAwaiting(state.awaitingRepresentative);
    if (state.updates.newAnswers) onUpdateRef.current?.(updateNotification());
  }, []);

  const refresh = useCallback(async () => {
    applyState(await api.getState());
  }, [api, applyState]);

  // First time the window is opened: create the session and load what the server already has (a returning employee).
  const loadedRef = useRef(false);
  useEffect(() => {
    if (!active || loadedRef.current) return;
    loadedRef.current = true;
    void api
      .ensureSession()
      .then(refresh)
      .catch((failure: unknown) => setError(describeApiError(failure, 'state')));
  }, [active, api, refresh]);

  // Every later time the window is shown again: catch up once (an answer may have arrived while it was closed).
  const wasActiveRef = useRef(active);
  useEffect(() => {
    const returned = active && !wasActiveRef.current;
    wasActiveRef.current = active;
    if (!returned || !loadedRef.current || busyRef.current) return;
    void refresh().catch(() => {
      // the next poll or message tries again
    });
  }, [active, refresh]);

  const hasSentMessage = sentHere || serverMessages.some((message) => message.role === 'user');
  const polling = shouldPollEmployee({
    active,
    hasSentMessage,
    awaitingRepresentative: awaiting,
    openQuestions: questions.length,
  });
  useEffect(() => {
    if (!polling) return;
    const poller = createPoller({
      intervalMs: EMPLOYEE_POLL_MS,
      tick: async () => {
        if (!busyRef.current) await refresh();
      },
    });
    poller.start();
    return () => poller.stop(); // the window was closed, or nothing is open any more
  }, [polling, refresh]);

  const submit = useCallback(async () => {
    const text = draft.trim();
    if (!text || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setDraft('');
    setSentHere(true);
    setPendingUser(text);
    let failure: unknown = null;
    try {
      await api.sendMessage(text);
    } catch (caught) {
      failure = caught;
      setError(describeApiError(caught, 'chat'));
      if (messageWasNotStored(caught)) setDraft((current) => (current === '' ? text : current));
    }
    try {
      await refresh(); // the stored conversation (also after a failure: the server may have kept the message)
    } catch (caught) {
      if (failure === null) setError(describeApiError(caught, 'state'));
    }
    setPendingUser(null);
    busyRef.current = false;
    setBusy(false);
  }, [api, draft, refresh]);

  const messages: DisplayMessage[] = [
    ...serverMessages.map((message) => ({ id: message.id, role: message.role, content: message.content })),
    ...(pendingUser !== null ? [{ id: 'pending-user', role: 'user' as const, content: pendingUser }] : []),
  ];

  return { messages, comparison, questions, awaiting, draft, setDraft, busy, error, hasAsked: messages.length > 0, submit };
}
