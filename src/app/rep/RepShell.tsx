import { ScopeRoot } from '../../components/car-advisor/ScopeRoot';
import styles from './rep.module.css';

const STRIP = [
  styles.stripRed,
  styles.stripOrange,
  styles.stripLightGreen,
  styles.stripGreen,
  styles.stripCyan,
  styles.stripBlue,
];

/**
 * Page frame of the rep console: scope root (tokens, direction, language), brand strip and a centered column.
 * TODO: rep-only access is not enforced yet. The real app must restrict /rep and /rep/[id] to reps on the server
 * (SSO role check), and the real API must enforce the same rule. This UI-only phase does not.
 */
export function RepShell({ children }: { children: React.ReactNode }) {
  return (
    <ScopeRoot>
      <div className={styles.page}>
        <div className={styles.strip} aria-hidden="true">
          {STRIP.map((color) => (
            <i key={color} className={color} />
          ))}
        </div>
        <main className={styles.main}>{children}</main>
      </div>
    </ScopeRoot>
  );
}

interface RepHeaderProps {
  title: string;
  subtitle: string;
  /** Shown at the opposite edge of the title, for example the SLA badge. */
  trailing?: React.ReactNode;
}

export function RepHeader({ title, subtitle, trailing }: RepHeaderProps) {
  return (
    <header className={styles.header}>
      <div>
        <h1 className={styles.headerTitle}>{title}</h1>
        <p className={styles.headerSubtitle}>{subtitle}</p>
      </div>
      {trailing}
    </header>
  );
}
