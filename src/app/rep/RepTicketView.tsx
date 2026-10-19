'use client';

import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { he } from '../../components/car-advisor/content/he';
import { fill } from '../../components/car-advisor/content/fill';
import { mockClient } from '../../components/car-advisor/contract/mockClient';
import type { CarAdvisorClient, RepTicketDetail } from '../../components/car-advisor/contract/types';
import { Badge, Button, Card, CheckList } from '../../components/car-advisor/ui';
import { RepHeader, RepShell } from './RepShell';
import { SLA_LABEL, STATUS_LABEL } from './repLabels';
import styles from './rep.module.css';

type Outcome = 'sent' | 'info-requested' | null;

/**
 * Rep console, single ticket (screen 5). The rep answers THE BOT, not the employee: the bot words the answer,
 * notifies the employee and returns it in the chat. The answer text lives only in this component's state.
 */
export function RepTicketView({ id, client = mockClient }: { id: string; client?: CarAdvisorClient }) {
  const [ticket, setTicket] = useState<RepTicketDetail | null | undefined>(undefined);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const fieldId = useId();

  useEffect(() => {
    let cancelled = false;
    void client.getRepTicket(id).then((found) => {
      if (!cancelled) setTicket(found);
    });
    return () => {
      cancelled = true;
    };
  }, [client, id]);

  async function run(action: () => Promise<void>, result: Exclude<Outcome, null>) {
    setBusy(true);
    try {
      await action();
      setTicket(await client.getRepTicket(id));
      setOutcome(result);
    } finally {
      setBusy(false);
    }
  }

  if (ticket === undefined) {
    return (
      <RepShell>
        <p role="status" className={styles.message}>
          {he.rep.loading}
        </p>
      </RepShell>
    );
  }

  if (ticket === null) {
    return (
      <RepShell>
        <Link href="/rep" className={styles.backLink}>
          {he.rep.backToList}
        </Link>
        <p className={styles.message}>{he.rep.notFound}</p>
      </RepShell>
    );
  }

  const answered = ticket.status === 'answered';
  const canSend = !busy && !answered && answer.trim().length > 0;

  return (
    <RepShell>
      <Link href="/rep" className={styles.backLink}>
        {he.rep.backToList}
      </Link>
      <RepHeader
        title={he.rep.title}
        subtitle={fill(he.rep.ticketSubtitle, {
          ticketNumber: ticket.ticketNumber,
          status: STATUS_LABEL[ticket.status],
        })}
        trailing={<Badge tone={ticket.slaLevel === 'overdue' ? 'danger' : 'info'}>{SLA_LABEL}</Badge>}
      />

      <div className={styles.detail}>
        <div className={styles.column}>
          <Card>
            <p className={styles.cardLabel}>{he.rep.questionLabel}</p>
            <p className={styles.questionText}>{ticket.questionText}</p>
          </Card>
          <Card>
            <h2 className={styles.cardTitle}>{he.rep.checkedTitle}</h2>
            <CheckList items={ticket.checked} />
          </Card>
        </div>

        <form
          className={styles.column}
          onSubmit={(event) => {
            event.preventDefault();
            if (canSend)
              void run(() => client.replyAsRep({ ticketId: ticket.id, answerText: answer }), 'sent');
          }}
        >
          <div>
            <label htmlFor={fieldId} className={styles.answerLabel}>
              {he.rep.answerLabel}
            </label>
            <textarea
              id={fieldId}
              className={styles.answerField}
              placeholder={he.rep.answerPlaceholder}
              maxLength={2000}
              value={answer}
              disabled={answered || busy}
              onChange={(event) => setAnswer(event.target.value)}
            />
            <p className={styles.helper}>{he.rep.helper}</p>
            {answered ? (
              <p role="status" className={styles.status}>
                {outcome === 'sent' ? he.rep.sent : he.rep.answered}
              </p>
            ) : outcome ? (
              <p role="status" className={styles.status}>
                {he.rep.infoRequested}
              </p>
            ) : null}
            <div className={styles.actions}>
              <Button
                variant="secondary"
                disabled={busy || answered}
                onClick={() => void run(() => client.requestMoreInfo(ticket.id), 'info-requested')}
              >
                {he.rep.requestInfo}
              </Button>
              <Button type="submit" disabled={!canSend}>
                {busy ? he.rep.sendBusy : he.rep.send}
              </Button>
            </div>
          </div>
        </form>
      </div>
    </RepShell>
  );
}
