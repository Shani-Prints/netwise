import { cx } from './cx';
import styles from './ui.module.css';

type Variant = 'primary' | 'secondary' | 'link';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  fullWidth?: boolean;
}

/** Semantic button with a 44px touch target. Defaults to type="button" so it never submits a form by accident. */
export function Button({ variant = 'primary', fullWidth = false, className, type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={cx(styles.button, styles[variant], fullWidth && styles.full, className)} {...rest} />;
}
