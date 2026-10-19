'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { fill } from '../../components/car-advisor/content/fill';
import { he } from '../../components/car-advisor/content/he';
import { mockClient } from '../../components/car-advisor/contract/mockClient';
import type { CarAdvisorClient, RepTicketSummary } from '../../components/car-advisor/contract/types';
import { Badge } from '../../components/car-advisor/ui';
import { RepHeader, RepShell } from './RepShell';
import { SLA_LABEL, STATUS_LABEL } from './repLabels';
import styles from './rep.module.css';

/** Rep console, list view: an even grid of fixed-size ticket cards. */
export function MockRepList({ client = mockClient, basePath = "/rep" }: { client?: CarAdvisorClient; basePath?: string }) {
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

  const openCount = tickets?.filter((ticket) => ticket.status !== 'answered').length ?? 0;
  const subtitle =
    tickets === null
      ? he.rep.loading
      : openCount === 0
        ? he.rep.listEmpty
        : openCount === 1
          ? he.rep.listCountOne
          : fill(he.rep.listCountMany, { count: String(openCount) });

  return (
    <RepShell>
      <RepHeader title={he.rep.title} subtitle={subtitle} />
      {tickets === null ? null : tickets.length === 0 ? (
        <p className={styles.message}>{he.rep.listEmpty}</p>
      ) : (
        <ul className={styles.ticketGrid}>
          {tickets.map((ticket) => (
            <li key={ticket.id} className={styles.ticketItem}>
              <Link href={`${basePath}/${ticket.id}`} className={styles.ticketLink}>
                <span className={styles.ticketTop}>
                  <span className={styles.ticketNumber}>
                    {fill(he.rep.listTicketLabel, { ticketNumber: ticket.ticketNumber })}
                  </span>
                  <Badge tone={ticket.slaLevel === 'overdue' ? 'danger' : 'info'}>{SLA_LABEL}</Badge>
                </span>
                <span className={styles.ticketStatus}>{STATUS_LABEL[ticket.status]}</span>
                <span className={styles.ticketQuestion}>{ticket.questionText}</span>
                <span className={styles.ticketOpen}>{he.rep.open}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </RepShell>
  );
}
