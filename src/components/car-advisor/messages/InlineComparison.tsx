import { fill } from '../content/fill';
import { he } from '../content/he';
import type { ApiComparison } from '../contract/types';
import styles from './api.module.css';
import { ComparisonPanel } from './ComparisonPanel';
import { SummaryAction } from './ComparisonSummary';
import { differenceText } from './comparisonFormat';

const L = he.api.comparison;

export interface ComparisonActions {
  /** Giving up the car is offered only when the saved occupation allows it. */
  waiverAllowed: boolean;
  disabled: boolean;
  /** Sends a normal chat message (the same path as typed text). */
  onSend: (message: string) => void;
}

export interface InlineComparisonProps {
  comparison: ApiComparison;
  /** An older comparison is one line (car name and the difference) with a button to expand it. */
  collapsed: boolean;
  onToggle: () => void;
  /** Only the latest comparison carries the action row ("compare another car"). */
  actions?: ComparisonActions;
}

/**
 * One comparison inside the conversation timeline, right after the bot message that announced it. All numbers come from the
 * server's result of that turn; nothing is recomputed here.
 */
export function InlineComparison({ comparison, collapsed, onToggle, actions }: InlineComparisonProps) {
  const diff = comparison.status === 'ok' && comparison.difference !== undefined ? differenceText(comparison.difference, fill) : '';
  if (collapsed) {
    return (
      <button
        type="button"
        className={styles.comparisonCollapsed}
        aria-expanded={false}
        aria-label={fill(L.collapsedAria, { label: comparison.alternativeLabel })}
        onClick={onToggle}
      >
        <span className={styles.comparisonCollapsedLabel}>
          {comparison.alternativeLabel}
          {diff ? ` · ${diff}` : ''}
        </span>
        <span className={styles.comparisonCollapsedAction}>{L.showComparison}</span>
      </button>
    );
  }
  return (
    <div className={styles.comparisonInline}>
      <ComparisonPanel comparison={comparison} />
      {actions ? (
        <div className={styles.comparisonActions} role="group" aria-label={L.actionsLabel}>
          <button
            type="button"
            className={styles.carChoiceButton}
            disabled={actions.disabled}
            onClick={() => actions.onSend(L.anotherCarMessage)}
          >
            {L.anotherCar}
          </button>
          {actions.waiverAllowed && comparison.alternativeRef.kind !== 'waiver' ? (
            <button
              type="button"
              className={styles.carChoiceButton}
              disabled={actions.disabled}
              onClick={() => actions.onSend(he.api.carChoices.pickWaiver)}
            >
              {he.api.carChoices.waiver}
            </button>
          ) : null}
          <SummaryAction comparison={comparison} />
        </div>
      ) : (
        <button type="button" className={styles.comparisonHide} aria-expanded onClick={onToggle}>
          {L.hideComparison}
        </button>
      )}
    </div>
  );
}
