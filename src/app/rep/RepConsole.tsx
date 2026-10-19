'use client';

import Link from 'next/link';
import { fill } from '../../components/car-advisor/content/fill';
import { he } from '../../components/car-advisor/content/he';
import { Badge, Button } from '../../components/car-advisor/ui';
import { RepGate } from './RepGate';
import { RepHeader, RepShell } from './RepShell';
import styles from './rep.module.css';
import appStyles from './repApp.module.css';

/** Real rep console, list view: questions from the server, refreshed about every 10 seconds. */
export function RepConsole() {
  return (
    <RepGate>
      {({ questions, error, reload }) => {
        const open = questions.filter((question) => question.status === 'open');
        const subtitle =
          open.length === 0
            ? he.repApp.list.empty
            : open.length === 1
              ? he.repApp.list.countOne
              : fill(he.repApp.list.countMany, { count: String(open.length) });
        return (
          <RepShell>
            <RepHeader
              title={he.repApp.consoleTitle}
              subtitle={subtitle}
              trailing={
                <Button variant="secondary" onClick={() => void reload()}>
                  {he.repApp.list.refresh}
                </Button>
              }
            />
            {error ? (
              <p role="alert" className={appStyles.errorLine}>
                {error}
              </p>
            ) : null}
            {questions.length === 0 ? (
              <p className={styles.message}>{he.repApp.list.empty}</p>
            ) : (
              <ul className={styles.ticketGrid}>
                {questions.map((question) => (
                  <li key={question.id} className={styles.ticketItem}>
                    <Link href={`/rep/${encodeURIComponent(question.id)}`} className={styles.ticketLink}>
                      <span className={styles.ticketTop}>
                        <span className={styles.ticketNumber}>{he.repApp.kinds[question.kind]}</span>
                        {question.followUpOf ? <Badge>{he.repApp.list.followUp}</Badge> : null}
                      </span>
                      <span className={styles.ticketStatus}>
                        {question.status === 'answered'
                          ? he.repApp.list.answeredBadge
                          : question.freeText
                            ? he.repApp.freeTextStates[question.freeText.state]
                            : he.repApp.freeTextStates.awaiting}
                      </span>
                      <span className={styles.ticketQuestion}>{question.questionText}</span>
                      <span className={styles.ticketOpen}>{he.repApp.list.open}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </RepShell>
        );
      }}
    </RepGate>
  );
}
