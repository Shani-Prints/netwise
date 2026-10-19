import { he } from '../content/he';
import { Chip } from '../ui/Chip';
import styles from './messages.module.css';

const CHIPS = [he.ask.chips.electric, he.ask.chips.otherCar, he.ask.chips.waiver, he.ask.chips.usageValue] as const;

interface GreetingProps {
  /** Suggestion chips are shown only before the first question. */
  showSuggestions: boolean;
  onPickSuggestion: (question: string) => void;
}

/** Bot greeting (the screen 1 headline), the suggestion chips and the info note. */
export function Greeting({ showSuggestions, onPickSuggestion }: GreetingProps) {
  return (
    <>
      <div>
        <h1 className={styles.greetingTitle}>{he.ask.headline}</h1>
        <p className={styles.greetingText}>{he.ask.intro}</p>
      </div>
      {showSuggestions ? (
        <section aria-label={he.ask.chipsLabel}>
          <p className={styles.chipsLabel}>{he.ask.chipsLabel}</p>
          <div className={styles.chips}>
            {CHIPS.map((chip) => (
              <Chip key={chip.label} onClick={() => onPickSuggestion(chip.question)}>
                {chip.label}
              </Chip>
            ))}
          </div>
        </section>
      ) : null}
      <p className={styles.note}>{he.ask.note}</p>
    </>
  );
}
