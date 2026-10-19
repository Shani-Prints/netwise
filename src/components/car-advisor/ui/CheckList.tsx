import { he } from '../content/he';
import type { CheckedItem } from '../contract/types';
import { CheckIcon, CrossIcon } from './Icons';
import styles from './ui.module.css';

/** "What was checked" list. Each row has an icon plus a screen-reader status, so it never relies on color alone. */
export function CheckList({ items }: { items: CheckedItem[] }) {
  return (
    <ul className={styles.checkList}>
      {items.map((item) => (
        <li key={item.label} className={styles.checkItem}>
          <span>{item.label}</span>
          {item.ok ? <CheckIcon className={styles.iconOk} /> : <CrossIcon className={styles.iconMissing} />}
          <span className={styles.srOnly}>{item.ok ? he.handoff.checkedOk : he.handoff.checkedMissing}</span>
        </li>
      ))}
    </ul>
  );
}
