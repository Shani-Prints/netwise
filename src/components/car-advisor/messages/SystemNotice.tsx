import { he } from '../content/he';
import styles from './api.module.css';

/** A fixed server notice in the conversation (for example "the representative updated a value"). Plain text only. */
export function SystemNotice({ text }: { text: string }) {
  return (
    <p className={styles.systemNotice}>
      <span className={styles.noticeLabel}>{he.api.systemNotice}</span>
      {text}
    </p>
  );
}
