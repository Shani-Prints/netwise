import { he } from '../content/he';
import type { ComparisonColumn, OptionKey } from '../contract/types';
import { cx } from './cx';
import { formatCell } from './format';
import styles from './ui.module.css';

const COLUMN_LABEL: Record<OptionKey, string> = {
  current: he.answer.table.colCurrent,
  electric: he.answer.table.colElectric,
  none: he.answer.table.colNone,
};

type RowKey = 'usageValue' | 'taxOnUsage' | 'netMonthly' | 'deltaVsCurrent';

const ROWS: { key: RowKey; label: string; strong?: boolean }[] = [
  { key: 'usageValue', label: he.answer.table.rowUsageValue },
  { key: 'taxOnUsage', label: he.answer.table.rowTaxOnUsage },
  { key: 'netMonthly', label: he.answer.table.rowNetMonthly, strong: true },
  { key: 'deltaVsCurrent', label: he.answer.table.rowDelta },
];

interface ComparisonTableProps {
  columns: ComparisonColumn[];
  highlighted: OptionKey;
}

export function ComparisonTable({ columns, highlighted }: ComparisonTableProps) {
  return (
    <table className={styles.table}>
      <caption className={styles.srOnly}>{he.answer.table.caption}</caption>
      <thead>
        <tr>
          <td />
          {columns.map((column) => (
            <th
              key={column.option}
              scope="col"
              className={cx(column.option === highlighted && styles.tableHeadHighlight)}
            >
              {COLUMN_LABEL[column.option]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {ROWS.map((row) => (
          <tr key={row.key}>
            <th scope="row" className={styles.tableRowHead}>
              {row.label}
            </th>
            {columns.map((column) => (
              <td
                key={column.option}
                className={cx(
                  row.strong && styles.tableStrong,
                  column.option === highlighted && styles.tableHighlight,
                )}
              >
                <bdi dir="ltr">{formatCell(column[row.key])}</bdi>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
