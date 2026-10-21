import { DocumentIcon } from '../ui/Icons';
import styles from './api.module.css';

/** A small chip on the employee's side: a payslip was attached and confirmed here. No value, no file name, no file content. */
export function PayslipMarker({ text }: { text: string }) {
  return (
    <p className={styles.payslipMarker}>
      <DocumentIcon size={16} />
      <span>{text}</span>
    </p>
  );
}
