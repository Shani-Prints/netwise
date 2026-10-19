import { cx } from './cx';
import styles from './ui.module.css';

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** "tint" is the light-blue info box; "plain" is the white card. */
  tone?: 'plain' | 'tint';
}

export function Card({ tone = 'plain', className, ...rest }: CardProps) {
  return <div className={cx(styles.card, tone === 'tint' && styles.tint, className)} {...rest} />;
}
