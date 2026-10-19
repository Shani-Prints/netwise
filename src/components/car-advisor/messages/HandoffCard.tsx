import { useId } from 'react';
import { he } from '../content/he';
import type { HandoffView, NotifyChannel } from '../contract/types';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { CheckList } from '../ui/CheckList';
import { RadioGroup } from '../ui/RadioGroup';
import { TextField } from '../ui/TextField';
import {
  checkContact,
  contactKindFor,
  type ContactKind,
  type ContactTouched,
  type ContactValues,
} from './contact';
import styles from './messages.module.css';

interface HandoffCardProps {
  handoff: HandoffView;
  channel: NotifyChannel;
  contacts: ContactValues;
  touched: ContactTouched;
  sending: boolean;
  sent: boolean;
  /** Masked contact shown (locked) after sending. The full value is not kept. */
  maskedContact: string | null;
  onChannelChange: (channel: NotifyChannel) => void;
  onContactChange: (kind: ContactKind, value: string) => void;
  onContactTouched: (kind: ContactKind) => void;
  onSend: () => void;
}

/** Screen 3: the bot has no reliable answer. What was checked, what goes to the rep, how to be notified. */
export function HandoffCard({
  handoff,
  channel,
  contacts,
  touched,
  sending,
  sent,
  maskedContact,
  onChannelChange,
  onContactChange,
  onContactTouched,
  onSend,
}: HandoffCardProps) {
  const radioName = useId();
  const locked = sending || sent;
  const kind = contactKindFor(channel);
  const copy = he.handoff.contact[kind];
  const value = contacts[kind];
  const valid = checkContact(kind, value).valid;
  // Errors appear after the field was left (or a send was attempted), not while the first characters are typed.
  const error =
    touched[kind] && !valid ? (value.trim() === '' ? he.handoff.contact.required : copy.error) : undefined;

  // Enter in the field sends when valid; otherwise it marks the field as touched so the error is shown.
  const trySend = () => {
    if (locked) return;
    if (valid) onSend();
    else onContactTouched(kind);
  };

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
        options={handoff.channels.map((option) => ({ value: option, label: he.handoff.channels[option] }))}
      />

      <TextField
        label={copy.label}
        value={sent ? (maskedContact ?? '') : value}
        onChange={(next) => onContactChange(kind, next)}
        onBlur={() => onContactTouched(kind)}
        onEnter={trySend}
        type={kind === 'phone' ? 'tel' : 'email'}
        inputMode={kind === 'phone' ? 'tel' : 'email'}
        autoComplete={kind === 'phone' ? 'tel' : 'email'}
        placeholder={copy.placeholder}
        hint={copy.hint}
        error={sent ? undefined : error}
        required
        disabled={locked}
        ltr
      />

      <Button fullWidth onClick={onSend} disabled={locked || !valid}>
        {sent ? he.handoff.submitted : sending ? he.handoff.submitBusy : he.handoff.submit}
      </Button>
      <p className={styles.centerNote}>{he.handoff.expectedTime}</p>
    </div>
  );
}
