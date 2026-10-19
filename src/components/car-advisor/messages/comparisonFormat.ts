import { he } from '../content/he';
import type { ApiComparison, ApiComponents } from '../contract/types';

/** Whole shekels with thousands separators. A negative amount gets a real minus sign. */
export function formatShekel(amount: number): string {
  const body = Math.abs(amount).toLocaleString('he-IL');
  return `${amount < 0 ? '−' : ''}₪${body}`;
}

export interface ComparisonRow {
  key: keyof ApiComponents;
  label: string;
  today: number;
  alternative: number;
  strong: boolean;
}

const ROW_ORDER: (keyof typeof he.api.comparison.rows)[] = [
  'usageValue',
  'maintenance',
  'evGrossUp',
  'tax',
  'nationalInsurance',
  'health',
  'pension',
  'studyFund',
  'participation',
  'familyShare',
  'net',
];

/**
 * The rows of the table: the server's rounded numbers as they are. A row where both columns are zero is left out
 * (except the net), so the card shows only what matters. Nothing is computed here.
 */
export function comparisonRows(comparison: ApiComparison): ComparisonRow[] {
  const today = comparison.today?.components;
  const alternative = comparison.alternative?.components;
  if (!today || !alternative) return [];
  return ROW_ORDER.filter((key) => key === 'net' || today[key] !== 0 || alternative[key] !== 0).map((key) => ({
    key,
    label: he.api.comparison.rows[key],
    today: today[key],
    alternative: alternative[key],
    strong: key === 'net',
  }));
}

/** The sentence about the difference, from the server's number. */
export function differenceText(difference: number, format: (template: string, values: Record<string, string>) => string): string {
  if (difference > 0) return format(he.api.comparison.differenceUp, { amount: formatShekel(difference) });
  if (difference < 0) return format(he.api.comparison.differenceDown, { amount: formatShekel(Math.abs(difference)) });
  return he.api.comparison.differenceNone;
}
