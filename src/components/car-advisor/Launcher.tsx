import { forwardRef } from 'react';
import { he } from './content/he';
import styles from './FloatingChat.module.css';
import { CarIcon } from './ui/Icons';

interface LauncherProps {
  expanded: boolean;
  unread: boolean;
  controlsId?: string;
  onClick: () => void;
  className?: string;
}

/** Round launcher button (56px). Presentational: positioning is done by the shell. */
export const Launcher = forwardRef<HTMLButtonElement, LauncherProps>(function Launcher(
  { expanded, unread, controlsId, onClick, className = '' },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={`${styles.launcher} ${className}`}
      aria-expanded={expanded}
      aria-controls={controlsId}
      aria-label={unread ? `${he.launcher.open}. ${he.launcher.unread}` : he.launcher.open}
      onClick={onClick}
    >
      <CarIcon size={28} />
      {unread ? <span className={styles.badge} aria-hidden="true">1</span> : null}
    </button>
  );
});
