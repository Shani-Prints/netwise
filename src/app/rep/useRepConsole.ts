import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, describeApiError, type AdvisorApiClient } from '../../components/car-advisor/contract/apiClient';
import type { ApiRepQuestion } from '../../components/car-advisor/contract/apiTypes';
import { createPoller } from '../../components/car-advisor/contract/poller';
import { REP_POLL_MS } from '../../components/car-advisor/contract/pollPolicy';

export type RepPhase = 'loading' | 'login' | 'ready' | 'error';

/** Whether a failed list call means "sign in as a representative" (no session, or a session of an employee). */
export function needsRepLogin(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

/**
 * State of the real rep console: the list of questions from GET /api/rep/questions, refreshed every ~10 seconds while it is
 * shown, and the login. The access code is passed straight to the client and is never kept here.
 */
export function useRepConsole(api: AdvisorApiClient) {
  const [phase, setPhase] = useState<RepPhase>('loading');
  const [questions, setQuestions] = useState<ApiRepQuestion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const phaseRef = useRef<RepPhase>('loading');

  const load = useCallback(
    () =>
      api.repListQuestions().then(
        (list) => {
          setQuestions(list);
          setError(null);
          phaseRef.current = 'ready';
          setPhase('ready');
        },
        (failure: unknown) => {
          if (needsRepLogin(failure)) {
            phaseRef.current = 'login';
            setPhase('login');
            return;
          }
          setError(describeApiError(failure, 'repList'));
          if (phaseRef.current !== 'ready') {
            phaseRef.current = 'error';
            setPhase('error');
          }
        },
      ),
    [api],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (phase !== 'ready') return;
    const poller = createPoller({ intervalMs: REP_POLL_MS, tick: load });
    poller.start();
    return () => poller.stop();
  }, [phase, load]);

  /** Throws the ApiError on a wrong code, so the form can show the friendly message. */
  const login = useCallback(
    async (code: string) => {
      await api.repLogin(code);
      await load();
    },
    [api, load],
  );

  /** Puts an updated question (the answer response) into the list without waiting for the next poll. */
  const replaceQuestion = useCallback((question: ApiRepQuestion) => {
    setQuestions((current) => current.map((item) => (item.id === question.id ? question : item)));
  }, []);

  return { phase, questions, error, reload: load, login, replaceQuestion };
}
