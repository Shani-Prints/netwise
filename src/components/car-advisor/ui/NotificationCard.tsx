import { he } from '../content/he';
import type { NotificationView } from '../contract/types';
import { cx } from './cx';
import { CarIcon } from './Icons';
import styles from './ui.module.css';

interface NotificationCardProps {
  notification: NotificationView;
  /** When given, the whole card is a button (for example to open the chat). */
  onOpen?: () => void;
}

/** In-app notification card. UI only: real push delivery is a separate backend step. */
export function NotificationCard({ notification, onOpen }: NotificationCardProps) {
  const content = (
    <>
      <span className={styles.notificationTop}>
        <span className={styles.notificationApp}>
          <span className={styles.notificationTile} aria-hidden="true">
            <CarIcon size={14} />
          </span>
          {he.notification.appName}
        </span>
        <span>{notification.timeLabel}</span>
      </span>
      <span className={styles.notificationTitle}>{notification.title}</span>
      <span className={styles.notificationBody}>{notification.body}</span>
    </>
  );
  return onOpen ? (
    <button type="button" onClick={onOpen} className={cx(styles.notification, styles.notificationButton)}>
      {content}
    </button>
  ) : (
    <div role="status" className={styles.notification}>
      {content}
    </div>
  );
}
