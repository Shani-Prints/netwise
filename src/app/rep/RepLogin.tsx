'use client';

import { useState } from 'react';
import { he } from '../../components/car-advisor/content/he';
import { describeApiError } from '../../components/car-advisor/contract/apiClient';
import { Button, TextField } from '../../components/car-advisor/ui';
import styles from './rep.module.css';
import appStyles from './repApp.module.css';

/**
 * Representative sign-in. The access code lives only in this component's state while it is typed; it is cleared after every
 * attempt and is never written to localStorage, a URL or a log.
 */
export function RepLogin({ onLogin }: { onLogin: (code: string) => Promise<void> }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy || code === '') return;
    const attempt = code;
    setBusy(true);
    setError(null);
    setCode('');
    try {
      await onLogin(attempt);
    } catch (failure) {
      setError(describeApiError(failure, 'repLogin'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className={appStyles.loginCard}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2 className={styles.cardTitle}>{he.repApp.login.title}</h2>
      <p className={styles.helper}>{he.repApp.login.help}</p>
      <TextField
        label={he.repApp.login.codeLabel}
        type="password"
        autoComplete="off"
        value={code}
        onChange={setCode}
        disabled={busy}
        ltr
      />
      {error ? (
        <p role="alert" className={appStyles.errorLine}>
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={busy || code === ''}>
        {busy ? he.repApp.login.busy : he.repApp.login.submit}
      </Button>
    </form>
  );
}
