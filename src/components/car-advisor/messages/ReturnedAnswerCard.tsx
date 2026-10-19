import { useState } from 'react';
import { fill } from '../content/fill';
import { he } from '../content/he';
import type { ReturnedAnswerView } from '../contract/types';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { formatCell } from '../ui/format';
import styles from './messages.module.css';

interface ReturnedAnswerCardProps {
  returned: ReturnedAnswerView;
  onAnotherQuestion: () => void;
}

/** Screen 7: the rep's answer, returned by the bot and labeled as approved by a rep. */
export function ReturnedAnswerCard({ returned, onAnotherQuestion }: ReturnedAnswerCardProps) {
  // TODO: send the "this helped" feedback through the client once the real API has an endpoint for it.
  const [helpful, setHelpful] = useState(false);
  const rows = [
    { label: he.returned.rowNetToday, value: returned.netToday, strong: false },
    { label: he.returned.rowNetWithElectric, value: returned.netWithElectric, strong: false },
    { label: he.returned.rowDelta, value: returned.delta, strong: true },
  ];
  return (
    <div className={styles.answer}>
      <p className={styles.hint}>{fill(he.returned.repRepliedAt, { time: returned.repRepliedAtLabel })}</p>
      <p>{he.returned.intro}</p>

      <Card>
        <dl className={styles.figures}>
          {rows.map((row) => (
            <div key={row.label} className={styles.figureRow}>
              <dt className={row.strong ? styles.figureStrong : undefined}>{row.label}</dt>
              <dd className={row.strong ? styles.figureStrong : undefined}>
                <bdi dir="ltr">{formatCell(row.value)}</bdi>
              </dd>
            </div>
          ))}
        </dl>
        <hr className={styles.divider} />
        <p>{returned.repExplanation}</p>
      </Card>

      <p className={styles.approved}>{fill(he.returned.approvedBy, { team: returned.approvedByTeam })}</p>

      <div className={styles.actions}>
        <Button variant="secondary" onClick={() => setHelpful(true)} disabled={helpful}>
          {he.returned.helpful}
        </Button>
        <Button variant="secondary" onClick={onAnotherQuestion}>
          {he.returned.anotherQuestion}
        </Button>
      </div>
      {helpful ? (
        <p role="status" className={styles.centerNote}>
          {he.returned.thanks}
        </p>
      ) : null}
    </div>
  );
}
