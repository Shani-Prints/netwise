import { he } from '../content/he';
import { fill } from '../content/fill';
import type { ApiCarChoices } from '../contract/types';
import styles from './api.module.css';

const L = he.api.carChoices;

type Group = { key: 'electric' | 'hybrid' | 'petrol'; title: string };
const GROUPS: Group[] = [
  { key: 'electric', title: L.electric },
  { key: 'hybrid', title: L.hybrid },
  { key: 'petrol', title: L.petrol },
];
// plug-in hybrids are listed with the hybrids
const groupOf = (drive: ApiCarChoices['cars'][number]['drive']): Group['key'] => (drive === 'plugin' ? 'hybrid' : drive);

export interface CarChoicesProps {
  choices: ApiCarChoices;
  /** True while a request runs: every button is disabled. */
  disabled?: boolean;
  /** Called with the employee message to send (the same path as typed text). */
  onChoose: (message: string) => void;
}

/**
 * The cars the server offers, as real buttons: grouped by fuel (electric first), each showing "maker model (year)". A click only sends
 * a normal chat message; for the current car the message says it is the CURRENT car, for the car to compare it says "compare to".
 */
export function CarChoices({ choices, disabled = false, onChoose }: CarChoicesProps) {
  const current = choices.purpose === 'current';
  const title = current ? L.titleCurrent : L.titleTarget;
  return (
    <div className={styles.carChoices} role="group" aria-label={L.listLabel} data-purpose={choices.purpose}>
      <p className={styles.carChoicesTitle}>{title}</p>
      <div className={styles.carChoicesScroll}>
        {GROUPS.map((g) => {
          const cars = choices.cars.filter((c) => groupOf(c.drive) === g.key);
          if (cars.length === 0) return null;
          return (
            <div key={g.key} className={styles.carChoicesGroup}>
              <p className={styles.carChoicesGroupTitle}>{g.title}</p>
              <div className={styles.carChoicesRow}>
                {cars.map((car) => (
                  <button
                    key={car.id}
                    type="button"
                    className={styles.carChoiceButton}
                    disabled={disabled}
                    aria-label={fill(current ? L.chooseCurrentAria : L.chooseAria, { label: car.label })}
                    onClick={() => onChoose(fill(current ? L.pickCurrent : L.pickTarget, { label: car.label }))}
                  >
                    {car.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {!current && choices.waiverAllowed ? (
          <div className={styles.carChoicesGroup}>
            <div className={styles.carChoicesRow}>
              <button
                type="button"
                className={styles.carChoiceButton}
                disabled={disabled}
                aria-label={L.waiver}
                onClick={() => onChoose(L.pickWaiver)}
              >
                {L.waiver}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
