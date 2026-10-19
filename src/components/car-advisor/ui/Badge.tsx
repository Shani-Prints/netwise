import { cx } from './cx';
import styles from './ui.module.css';

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: 'info' | 'danger';
}

export function Badge({ tone = 'info', className, ...rest }: BadgeProps) {
  return <span className={cx(styles.badge, tone === 'danger' ? styles.badgeDanger : styles.badgeInfo, className)} {...rest} />;
}
