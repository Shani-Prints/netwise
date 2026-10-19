import { cx } from './cx';
import styles from './ui.module.css';

export function Chip({ className, type = 'button', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={cx(styles.chip, className)} {...rest} />;
}
