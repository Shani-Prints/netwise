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
 * Access is enforced by the API (rep session cookie, 401/403); the real pages sign in through POST /api/session/rep.
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
