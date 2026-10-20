import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Payslip } from '../../lib/payslip-schema';
import { payslipToProfileFields } from '../../lib/payslip-to-engine';
import { PrepareError, prepareFiles } from '../../lib/prepare-files';
import { createChatStore, displayMessages, initialChatState } from './chatStore';
import { he } from './content/he';
import { ApiError, describeApiError, type AdvisorApiClient } from './contract/apiClient';
import { createPoller } from './contract/poller';
import { EMPLOYEE_POLL_MS, shouldPollEmployee } from './contract/pollPolicy';
import type { NotificationView } from './contract/types';

export { messageWasNotStored, updateNotification, type DisplayMessage } from './chatStore';

/** The payslip flow inside the chat: reading the files, then the confirmation card. Held in memory only; files are never kept. */
export type PayslipFlow = { phase: 'parsing' } | { phase: 'review'; data: Payslip } | null;

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

  // ---- payslip upload: read -> confirmation card -> save -> the bot continues by itself (no user bubble) ----
  const [payslip, setPayslip] = useState<PayslipFlow>(null);
  const [payslipBusy, setPayslipBusy] = useState(false);
  const [payslipError, setPayslipError] = useState<string | null>(null);
  const payslipBusyRef = useRef(false);

  const attachPayslip = useCallback(
    async (files: File[]) => {
      if (files.length === 0 || payslipBusyRef.current || store.getState().busy) return;
      payslipBusyRef.current = true;
      setPayslipBusy(true);
      setPayslipError(null);
      setPayslip({ phase: 'parsing' });
      try {
        const prepared = await prepareFiles(files);
        const result = await api.parsePayslip(prepared);
        setPayslip({ phase: 'review', data: result.data });
      } catch (caught) {
        setPayslip(null);
        setPayslipError(
          caught instanceof PrepareError
            ? caught.message
            : caught instanceof ApiError && caught.serverMessage
              ? caught.serverMessage
              : describeApiError(caught, 'chat'),
        );
      }
      payslipBusyRef.current = false;
      setPayslipBusy(false);
    },
    [api, store],
  );

  const confirmPayslip = useCallback(
    async (data: Payslip) => {
      if (payslipBusyRef.current) return;
      const fields = payslipToProfileFields(data);
      if (Object.keys(fields).length === 0) {
        setPayslipError(he.api.payslip.noUsable);
        return;
      }
      payslipBusyRef.current = true;
      setPayslipBusy(true);
      setPayslipError(null);
      try {
        await api.confirmPayslip(fields);
      } catch {
        setPayslipError(he.api.payslip.saveFailed);
        payslipBusyRef.current = false;
        setPayslipBusy(false);
        return;
      }
      setPayslip(null); // the card closes; nothing from the payslip stays in the browser
      try {
        await api.sendPayslipConfirmed(); // the bot's turn (no user bubble)
      } catch (caught) {
        setPayslipError(describeApiError(caught, 'chat'));
      }
      try {
        await store.refresh();
      } catch (caught) {
        setPayslipError(describeApiError(caught, 'state'));
      }
      payslipBusyRef.current = false;
      setPayslipBusy(false);
    },
    [api, store],
  );

  const cancelPayslip = useCallback(() => setPayslip(null), []);

  const messages = displayMessages(state);
  return {
    messages,
    comparison: state.comparison,
    questions: state.questions,
    awaiting: state.awaiting,
    draft: state.draft,
    setDraft: store.setDraft,
    busy: state.busy || payslipBusy,
    error: state.error ?? payslipError,
    hasAsked: messages.length > 0,
    submit: store.submit,
    payslip,
    attachPayslip,
    confirmPayslip,
    cancelPayslip,
  };
}

const serverSnapshot = initialChatState();
function initialChatStateGetter() {
  return serverSnapshot;
}
