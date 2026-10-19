import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { createChatStore, displayMessages, initialChatState } from './chatStore';
import type { AdvisorApiClient } from './contract/apiClient';
import { createPoller } from './contract/poller';
import { EMPLOYEE_POLL_MS, shouldPollEmployee } from './contract/pollPolicy';
import type { NotificationView } from './contract/types';

export { messageWasNotStored, updateNotification, type DisplayMessage } from './chatStore';

/**
 * Chat state of the REAL widget (the logic lives in chatStore.ts, which has no React in it and is unit tested). The conversation,
 * the comparison and the questions all come from the server (GET /api/employee/state); nothing is persisted in the browser.
 * The server is read once when the window is first opened, after every message, when the window is shown again, and every ~10
 * seconds while a question is open and the window is open. `onUpdate` is called when a representative's answer was applied.
 */
export function useApiChatController(api: AdvisorApiClient, active: boolean, onUpdate?: (n: NotificationView) => void) {
  const store = useMemo(() => createChatStore(api), [api]);
  useEffect(() => {
    store.setOnUpdate(onUpdate);
  }, [store, onUpdate]);
  const state = useSyncExternalStore(store.subscribe, store.getState, initialChatStateGetter);

  // First time the window is opened: create the session and load what the server already has (a returning employee).
  const loadedRef = useRef(false);
  useEffect(() => {
    if (!active || loadedRef.current) return;
    loadedRef.current = true;
    void store.load();
  }, [active, store]);

  // Every later time the window is shown again: catch up once (an answer may have arrived while it was closed).
  const wasActiveRef = useRef(active);
  useEffect(() => {
    const returned = active && !wasActiveRef.current;
    wasActiveRef.current = active;
    if (!returned || !loadedRef.current || store.getState().busy) return;
    void store.refresh().catch(() => {
      // the next poll or message tries again
    });
  }, [active, store]);

  const polling = shouldPollEmployee({
    active,
    hasSentMessage: state.sentHere || state.serverMessages.some((m) => m.role === 'user'),
    awaitingRepresentative: state.awaiting,
    openQuestions: state.questions.length,
  });
  useEffect(() => {
    if (!polling) return;
    const poller = createPoller({
      intervalMs: EMPLOYEE_POLL_MS,
      tick: async () => {
        if (!store.getState().busy) await store.refresh();
      },
    });
    poller.start();
    return () => poller.stop(); // the window was closed, or nothing is open any more
  }, [polling, store]);

  const messages = displayMessages(state);
  return {
    messages,
    comparison: state.comparison,
    questions: state.questions,
    awaiting: state.awaiting,
    draft: state.draft,
    setDraft: store.setDraft,
    busy: state.busy,
    error: state.error,
    hasAsked: messages.length > 0,
    submit: store.submit,
  };
}

const serverSnapshot = initialChatState();
function initialChatStateGetter() {
  return serverSnapshot;
}
