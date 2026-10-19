import { useId } from 'react';
import { cx } from './cx';
import styles from './ui.module.css';

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  onEnter?: () => void;
  type?: 'text' | 'tel' | 'email' | 'password';
  inputMode?: 'text' | 'tel' | 'email';
  autoComplete?: string;
  placeholder?: string;
  hint?: string;
  /** When set, the field is shown as invalid and the message is linked with aria-describedby. */
  error?: string;
  required?: boolean;
  disabled?: boolean;
  /** Left-to-right value (phone numbers, emails) inside a right-to-left layout. */
  ltr?: boolean;
}

/** Labeled input with an optional hint and error. The label is a real <label>. */
export function TextField({
  label,
  value,
  onChange,
  onBlur,
  onEnter,
  type = 'text',
  inputMode,
  autoComplete,
  placeholder,
  hint,
  error,
  required,
  disabled,
  ltr,
}: TextFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint && !disabled ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.fieldLabel}>
        {label}
      </label>
      <input
        id={id}
        type={type}
        inputMode={inputMode}
        autoComplete={autoComplete}
        placeholder={placeholder}
        value={value}
        required={required}
        disabled={disabled}
        dir={ltr ? 'ltr' : undefined}
        aria-required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={cx(styles.fieldInput, ltr && styles.fieldInputLtr, error && styles.fieldInputInvalid)}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing && onEnter) {
            event.preventDefault();
            onEnter();
          }
        }}
      />
      {hint && !disabled ? (
        <p id={hintId} className={styles.fieldHint}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className={styles.fieldError}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
