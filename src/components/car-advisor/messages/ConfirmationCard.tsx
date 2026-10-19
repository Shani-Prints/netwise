import { he } from '../content/he';
import type { TicketConfirmationView } from '../contract/types';
import { Card } from '../ui/Card';
import { CheckIcon } from '../ui/Icons';
import { StepList } from '../ui/StepList';
import styles from './messages.module.css';

interface ConfirmationCardProps {
  confirmation: TicketConfirmationView;
}

/** Screen 4: the ticket was received. Ticket number and a three-step timeline. */
export function ConfirmationCard({ confirmation }: ConfirmationCardProps) {
  return (
    <div className={styles.answer}>
      <div className={styles.confirmationHead}>
        <span className={styles.confirmationIcon} aria-hidden="true">
          <CheckIcon size={32} />
        </span>
        <h2 className={styles.confirmationTitle}>{he.confirmation.title}</h2>
        <p className={styles.confirmationText}>
          {he.confirmation.text} <bdi dir="ltr">{confirmation.ticketNumber}</bdi>
        </p>
      </div>

      <Card>
        <StepList
          variant="timeline"
          items={[
            { title: he.confirmation.step1Title, detail: he.confirmation.step1Detail },
            { title: he.confirmation.step2Title, detail: he.confirmation.step2Detail },
            { title: he.confirmation.step3Title, detail: he.confirmation.step3Detail[confirmation.channel] },
          ]}
        />
      </Card>
    </div>
  );
}
