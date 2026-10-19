import { useId } from 'react';
import { he } from '../content/he';
import type { HandoffView, NotifyChannel } from '../contract/types';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { CheckList } from '../ui/CheckList';
import { RadioGroup } from '../ui/RadioGroup';
import styles from './messages.module.css';

interface HandoffCardProps {
  handoff: HandoffView;
  channel: NotifyChannel;
  sending: boolean;
  sent: boolean;
  onChannelChange: (channel: NotifyChannel) => void;
  onSend: () => void;
}

/** Screen 3: the bot has no reliable answer. What was checked, what goes to the rep, how to be notified. */
export function HandoffCard({ handoff, channel, sending, sent, onChannelChange, onSend }: HandoffCardProps) {
  const radioName = useId();
  const locked = sending || sent;
  return (
    <div className={styles.answer}>
      <p>{handoff.botMessage}</p>

      <Card>
        <h2 className={styles.sectionTitle}>{he.handoff.checkedTitle}</h2>
        <CheckList items={handoff.checked} />
      </Card>

      <Card tone="tint">
        <h2 className={styles.sectionTitleSmall}>{he.handoff.whatGoesTitle}</h2>
        <p className={styles.sources}>{he.handoff.whatGoesText}</p>
      </Card>

      <RadioGroup
        legend={he.handoff.notifyLegend}
        name={radioName}
        value={channel}
        onChange={onChannelChange}
        disabled={locked}
        options={handoff.channels.map((value) => ({ value, label: he.handoff.channels[value] }))}
      />

      <Button fullWidth onClick={onSend} disabled={locked}>
        {sent ? he.handoff.submitted : sending ? he.handoff.submitBusy : he.handoff.submit}
      </Button>
      <p className={styles.centerNote}>{he.handoff.expectedTime}</p>
    </div>
  );
}
