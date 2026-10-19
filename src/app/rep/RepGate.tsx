'use client';

import { useState } from 'react';
import { he } from '../../components/car-advisor/content/he';
import { createApiClient, type AdvisorApiClient } from '../../components/car-advisor/contract/apiClient';
import type { ApiRepQuestion } from '../../components/car-advisor/contract/apiTypes';
import { Button } from '../../components/car-advisor/ui';
import { RepLogin } from './RepLogin';
import { RepHeader, RepShell } from './RepShell';
import styles from './rep.module.css';
import appStyles from './repApp.module.css';
import { useRepConsole } from './useRepConsole';

export interface RepGateContext {
  api: AdvisorApiClient;
  questions: ApiRepQuestion[];
  /** Latest refresh error while the list is already shown (the old list stays). */
  error: string | null;
  reload: () => Promise<void>;
  replaceQuestion: (question: ApiRepQuestion) => void;
}

/**
 * Shared frame of the real console pages: loads the questions, shows the sign-in form when there is no representative
 * session (401/403), and renders `children` once the list is available.
 */
export function RepGate({ children }: { children: (context: RepGateContext) => React.ReactNode }) {
  const [api] = useState(() => createApiClient());
  const { phase, questions, error, reload, login, replaceQuestion } = useRepConsole(api);

  if (phase === 'ready') return <>{children({ api, questions, error, reload, replaceQuestion })}</>;

  return (
    <RepShell>
      {phase === 'login' ? (
        <>
          <RepHeader title={he.repApp.consoleTitle} subtitle={he.repApp.login.help} />
          <RepLogin onLogin={login} />
        </>
      ) : phase === 'error' ? (
        <>
          <RepHeader title={he.repApp.consoleTitle} subtitle="" />
          <p role="alert" className={appStyles.errorLine}>
            {error}
          </p>
          <div>
            <Button variant="secondary" onClick={() => void reload()}>
              {he.repApp.list.refresh}
            </Button>
          </div>
        </>
      ) : (
        <>
          <RepHeader title={he.repApp.consoleTitle} subtitle={he.rep.loading} />
          <p role="status" className={styles.message}>
            {he.rep.loading}
          </p>
        </>
      )}
    </RepShell>
  );
}
