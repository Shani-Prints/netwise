import { he } from '../content/he';
import uiStyles from '../ui/ui.module.css';
import styles from './typing.module.css';

/** Bot bubble with three waving dots, shown while the server checks the data. Announced once through the hidden text. */
export function TypingIndicator() {
  return (
    <div role="status" className={styles.typing}>
      <span aria-hidden="true" className={styles.dot} />
      <span aria-hidden="true" className={styles.dot} />
      <span aria-hidden="true" className={styles.dot} />
      <span className={uiStyles.srOnly}>{he.ask.typingLabel}</span>
    </div>
  );
}
