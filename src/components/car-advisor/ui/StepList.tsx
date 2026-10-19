import { cx } from './cx';
import styles from './ui.module.css';

export interface StepItem {
  title: string;
  detail?: string;
}

interface StepListProps {
  items: StepItem[];
  /**
   * "numbered": dark number badges (the answer explanation).
   * "timeline": the first step is active (blue), the rest are idle (confirmation card).
   */
  variant: 'numbered' | 'timeline';
}

export function StepList({ items, variant }: StepListProps) {
  return (
    <ol className={styles.steps}>
      {items.map((item, index) => {
        const tone =
          variant === 'numbered' ? styles.stepDark : index === 0 ? styles.stepActive : styles.stepIdle;
        return (
          <li key={item.title} className={styles.step}>
            <span className={cx(styles.stepNumber, tone)} aria-hidden="true">
              {index + 1}
            </span>
            <div>
              <p className={variant === 'timeline' ? styles.stepTitleStrong : undefined}>{item.title}</p>
              {item.detail ? <p className={styles.stepDetail}>{item.detail}</p> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
