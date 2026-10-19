import styles from './ui.module.css';

export interface RadioOption<T extends string> {
  value: T;
  label: string;
}

interface RadioGroupProps<T extends string> {
  legend: string;
  name: string;
  options: RadioOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

/** Native radio inputs inside a fieldset: keyboard and screen-reader behavior comes for free. */
export function RadioGroup<T extends string>({ legend, name, options, value, onChange }: RadioGroupProps<T>) {
  return (
    <fieldset>
      <legend className={styles.radioLegend}>{legend}</legend>
      <div className={styles.radioRow}>
        {options.map((option) => (
          <label key={option.value} className={styles.radioLabel}>
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
              className={styles.radioInput}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
