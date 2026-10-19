import { fmt, missingFieldLabel } from './explain';
import { loadRules } from '../config/rules';
import type { ComparisonView } from './view';

/** SHOW_PROVISIONAL_ALTERNATIVE (default "true"). Only the literal string "false" turns the provisional net off. */
export function showProvisionalAlternative(env: Record<string, string | undefined> = process.env): boolean {
  return (env.SHOW_PROVISIONAL_ALTERNATIVE ?? 'true').trim().toLowerCase() !== 'false';
}

/**
 * While a representative question is open and the flag is "false", the comparison keeps only today's net:
 * no alternative scenario, no difference. It is reported as "missing the participation in the new car".
 * No number is computed here; today's net is the engine's rounded value already in the view.
 */
export function applyProvisionalPolicy(view: ComparisonView, show: boolean): ComparisonView {
  if (show || !view.pendingQuestionId || view.status !== 'ok' || !view.today) return view;
  const { alternative: _alt, difference: _diff, ...rest } = view;
  const childMaxAge = loadRules().familyTrack.childMaxAge;
  return {
    ...rest,
    status: 'missing',
    missingFields: ['alternativeParticipation'],
    missingText: [missingFieldLabel('alternativeParticipation', childMaxAge)],
    explanation: [
      `הנטו החודשי המוערך שלך היום הוא ${fmt(view.today.components.net)} ₪.`,
      `בינתיים הנה המצב היום; החלופה "${view.alternativeLabel}" תתעדכן כשהנציג יענה על ההשתתפות ברכב.`,
    ],
    assumptions: [],
  };
}
