'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { fill } from '../../components/car-advisor/content/fill';
import { he } from '../../components/car-advisor/content/he';
import {
  describeApiError,
  MAX_REP_TEXT_CHARS,
  type AdvisorApiClient,
} from '../../components/car-advisor/contract/apiClient';
import type { ApiInterpretation, ApiRepQuestion } from '../../components/car-advisor/contract/apiTypes';
import { Badge, Button } from '../../components/car-advisor/ui';
import { numberHint, parseTypedAnswer } from './answerInput';
import { RepGate } from './RepGate';
import { RepHeader, RepShell } from './RepShell';
import styles from './rep.module.css';
import appStyles from './repApp.module.css';

/** Real rep console, one question. The question is found in the list (there is no single-question endpoint). */
export function RepTicket({ id }: { id: string }) {
  return (
    <RepGate>
      {({ api, questions, replaceQuestion, reload }) => {
        const question = questions.find((item) => item.id === id);
        if (!question) {
          return (
            <RepShell>
              <Link href="/rep" className={styles.backLink}>
                {he.rep.backToList}
              </Link>
              <p className={styles.message}>{he.rep.notFound}</p>
            </RepShell>
          );
        }
        return <TicketBody api={api} question={question} onChanged={replaceQuestion} reload={reload} />;
      }}
    </RepGate>
  );
}

const CONTEXT_FIELDS = ['carLabel', 'group', 'tableGroup', 'occupation'] as const;

interface BodyProps {
  api: AdvisorApiClient;
  question: ApiRepQuestion;
  onChanged: (question: ApiRepQuestion) => void;
  reload: () => Promise<void>;
}

function TicketBody({ api, question, onChanged, reload }: BodyProps) {
  const t = he.repApp.ticket;
  const ids = useId();
  const [typed, setTyped] = useState('');
  const [free, setFree] = useState('');
  const [busy, setBusy] = useState<'typed' | 'free' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ApiInterpretation | 'typed' | null>(null);

  const answered = question.status === 'answered';
  const spec = question.answerSpec;
  const context = question.context;

  async function sendTyped() {
    if (busy || answered) return;
    const value = parseTypedAnswer(spec, typed);
    if (value === null) {
      setError(he.api.errors.invalidAnswer);
      return;
    }
    setBusy('typed');
    setError(null);
    try {
      onChanged(await api.repAnswerTyped(question.id, value));
      setResult('typed');
      setTyped('');
    } catch (failure) {
      setError(describeApiError(failure, 'repAnswer'));
      void reload(); // the question may have been answered or closed meanwhile (409)
    } finally {
      setBusy(null);
    }
  }

  async function sendFree() {
    if (busy || answered || free.trim() === '') return;
    setBusy('free');
    setError(null);
    try {
      const response = await api.repAnswerText(question.id, free);
      onChanged(response.question);
      setResult(response.interpretation);
      setFree('');
      void reload(); // a clarification question may have been opened
    } catch (failure) {
      setError(describeApiError(failure, 'repAnswerText'));
    } finally {
      setBusy(null);
    }
  }

  const contextRows: { term: string; value: string; unverified?: boolean }[] = [];
  for (const key of CONTEXT_FIELDS) {
    const value = context[key];
    if (value) contextRows.push({ term: t[key], value });
  }
  if (context.wroteAbout) contextRows.push({ term: t.wroteAbout, value: context.wroteAbout, unverified: true });
  if (context.employeeRef) contextRows.push({ term: t.employeeRef, value: context.employeeRef, unverified: true });

  return (
    <RepShell>
      <Link href="/rep" className={styles.backLink}>
        {he.rep.backToList}
      </Link>
      <RepHeader
        title={he.repApp.kinds[question.kind]}
        subtitle={
          answered
            ? he.repApp.list.answeredBadge
            : question.freeText
              ? he.repApp.freeTextStates[question.freeText.state]
              : he.repApp.freeTextStates.awaiting
        }
        trailing={question.followUpOf ? <Badge>{he.repApp.list.followUp}</Badge> : undefined}
      />

      <div className={styles.detail}>
        <div className={styles.column}>
          <section className={`${styles.fixedCard} ${styles.questionCard}`}>
            <p id={`${ids}-q`} className={styles.cardLabel}>
              {t.questionLabel}
            </p>
            <div role="region" aria-labelledby={`${ids}-q`} tabIndex={0} className={styles.scrollRegion}>
              {/* plain text only: the server text is never interpreted as markup */}
              <p className={styles.questionText}>{question.questionText}</p>
            </div>
          </section>

          <section className={`${styles.fixedCard} ${styles.checkedCard}`}>
            <h2 id={`${ids}-c`} className={styles.cardTitle}>
              {t.contextTitle}
            </h2>
            <div role="region" aria-labelledby={`${ids}-c`} tabIndex={0} className={styles.scrollRegion}>
              {contextRows.length === 0 && !context.employeeRefMissing ? (
                <p className={styles.helper}>{t.contextEmpty}</p>
              ) : (
                <dl className={appStyles.contextList}>
                  {contextRows.map((row) => (
                    <div key={row.term} className={appStyles.contextRow}>
                      <dt className={appStyles.contextTerm}>{row.term}</dt>
                      <dd className={appStyles.contextValue}>
                        {row.value} {row.unverified ? <Badge tone="danger">{t.unverified}</Badge> : null}
                      </dd>
                    </div>
                  ))}
                  {context.employeeRefMissing ? (
                    <div className={appStyles.contextRow}>
                      <dt className={appStyles.contextTerm}>{t.employeeRef}</dt>
                      <dd className={appStyles.contextValue}>{t.refMissing}</dd>
                    </div>
                  ) : null}
                </dl>
              )}
            </div>
          </section>
        </div>

        <div className={appStyles.answerCard}>
          <p className={appStyles.warning}>{he.repApp.warning}</p>

          {answered ? (
            <div role="status">
              <p className={styles.status}>{t.answeredNote}</p>
              {question.answer ? (
                <p className={styles.helper}>
                  {t.yourAnswer}: {question.answer}
                </p>
              ) : null}
            </div>
          ) : (
            <>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void sendTyped();
                }}
              >
                <h2 className={styles.cardTitle}>{t.typedTitle}</h2>
                <div className={appStyles.typedRow}>
                  {spec.type === 'choice' ? (
                    <select
                      className={appStyles.typedInput}
                      aria-label={t.typedTitle}
                      value={typed}
                      disabled={busy !== null}
                      onChange={(event) => setTyped(event.target.value)}
                    >
                      <option value="">{t.choicePlaceholder}</option>
                      {spec.options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className={appStyles.typedInput}
                      type="text"
                      inputMode="decimal"
                      dir="ltr"
                      autoComplete="off"
                      aria-label={`${t.typedTitle} (${t.units[spec.unit]})`}
                      aria-describedby={`${ids}-hint`}
                      value={typed}
                      disabled={busy !== null}
                      onChange={(event) => setTyped(event.target.value)}
                    />
                  )}
                  <Button type="submit" disabled={busy !== null || typed.trim() === ''}>
                    {busy === 'typed' ? t.sending : t.submitTyped}
                  </Button>
                </div>
                {spec.type === 'number' ? (
                  <p id={`${ids}-hint`} className={styles.helper}>
                    {numberHint(spec)} · {t.units[spec.unit]}
                  </p>
                ) : null}
              </form>

              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void sendFree();
                }}
              >
                <h2 className={styles.cardTitle}>{t.freeTitle}</h2>
                <label htmlFor={`${ids}-free`} className={styles.helper}>
                  {fill(t.freeHelp, { max: String(MAX_REP_TEXT_CHARS) })}
                </label>
                <textarea
                  id={`${ids}-free`}
                  className={appStyles.freeField}
                  placeholder={t.freePlaceholder}
                  maxLength={MAX_REP_TEXT_CHARS}
                  value={free}
                  disabled={busy !== null}
                  onChange={(event) => setFree(event.target.value)}
                />
                <p className={appStyles.counter}>
                  {free.length}/{MAX_REP_TEXT_CHARS}
                </p>
                <Button type="submit" variant="secondary" disabled={busy !== null || free.trim() === ''}>
                  {busy === 'free' ? t.sending : t.submitFree}
                </Button>
              </form>
            </>
          )}

          <div role="status">
            {result && result !== 'typed' ? <p className={styles.status}>{he.repApp.interpretation[result]}</p> : null}
            {result === 'typed' ? <p className={styles.status}>{he.repApp.interpretation.applied}</p> : null}
          </div>
          {error ? (
            <p role="alert" className={appStyles.errorLine}>
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </RepShell>
  );
}
