import { he } from '../content/he';
import type { Cell } from '../contract/types';

const SHEKEL = '₪';

/** Text for a table cell. A money cell without an amount renders the marked placeholder. */
export function formatCell(cell: Cell): string {
  switch (cell.kind) {
    case 'dash':
      return '—';
    case 'not-applicable':
      return he.answer.table.notApplicable;
    case 'money': {
      const body =
        cell.amount === null
          ? he.answer.table.placeholderAmount
          : Math.abs(cell.amount).toLocaleString('he-IL');
      const negative = cell.amount === null ? cell.signHint === 'negative' : cell.amount < 0;
      const positive = cell.amount === null ? cell.signHint === 'positive' : cell.amount > 0;
      const sign = negative ? '−' : positive ? '+' : '';
      return `${sign}${SHEKEL}${body}`;
    }
  }
}
