'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { he } from '../../components/car-advisor/content/he';
import { fill } from '../../components/car-advisor/content/fill';
import { mockClient } from '../../components/car-advisor/contract/mockClient';
import type { CarAdvisorClient, RepTicketSummary } from '../../components/car-advisor/contract/types';
import { Badge } from '../../components/car-advisor/ui';
import { RepHeader, RepShell } from './RepShell';
import { SLA_LABEL, STATUS_LABEL } from './repLabels';
import styles from './rep.module.css';

/** Rep console, list view: open tickets, most urgent first as delivered by the client. */
export function RepList({ client = mockClient }: { client?: CarAdvisorClient }) {
  const [tickets, setTickets] = useState<RepTicketSummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void client.listRepTickets().then((list) => {
      if (!cancelled) setTickets(list);
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  return (
    <RepShell>
      <RepHeader title={he.rep.title} subtitle={he.rep.listSubtitle} />
      {tickets === null ? (
        <p role="status" className={styles.message}>
          {he.rep.loading}
        </p>
      ) : tickets.length === 0 ? (
        <p className={styles.message}>{he.rep.listEmpty}</p>
      ) : (
        <ul className={styles.ticketGrid}>
          {tickets.map((ticket) => (
            <li key={ticket.id}>
              <Link href={`/rep/${ticket.id}`} className={styles.ticketLink}>
                <span className={styles.ticketTop}>
                  <span className={styles.ticketNumber}>
                    {fill(he.rep.listTicketLabel, { ticketNumber: ticket.ticketNumber })}
                  </span>
                  <Badge tone={ticket.slaLevel === 'overdue' ? 'danger' : 'info'}>{SLA_LABEL}</Badge>
                </span>
                <span className={styles.ticketStatus}>{STATUS_LABEL[ticket.status]}</span>
                <span className={styles.ticketQuestion}>{ticket.questionText}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </RepShell>
  );
}
