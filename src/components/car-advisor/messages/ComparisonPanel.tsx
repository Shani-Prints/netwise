import { fill } from '../content/fill';
import { he } from '../content/he';
import type { ApiComparison } from '../contract/types';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';
import uiStyles from '../ui/ui.module.css';
import styles from './api.module.css';
import { comparisonRows, differenceText, formatShekel } from './comparisonFormat';

function Bullets({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      {title ? <p className={styles.listTitle}>{title}</p> : null}
      <ul className={styles.bullets}>
        {items.map((item, index) => (
          <li key={`${index}-${item}`}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The comparison the server computed (ComparisonView). Every number is the server's, already rounded; every text is plain
 * text. While data is missing no net for the alternative is shown, only the reason (and today's net when the server has it).
 */
export function ComparisonPanel({ comparison }: { comparison: ApiComparison }) {
  const c = comparison;
  const rows = comparisonRows(c);
  const c18 = he.api.comparison;
  const showTable = c.status === 'ok' && rows.length > 0;
  // The first line of a numeric result is the headline sentence the chat bubble already says; the panel keeps the reasons line.
  const explanationLines = c.status === 'ok' ? c.explanation.slice(1) : c.explanation;

  return (
    <Card>
      <div className={styles.panel}>
        <h2 className={styles.panelTitle}>{c18.title}</h2>
        {showTable ? null : <p className={styles.panelSub}>{fill(c18.caption, { alternative: c.alternativeLabel })}</p>}

        {showTable ? (
          <>
            <table className={uiStyles.table}>
              <caption className={styles.panelSub}>{fill(c18.caption, { alternative: c.alternativeLabel })}</caption>
              <thead>
                <tr>
                  <th scope="col" className={styles.headCell}>
                    {c18.colItem}
                  </th>
                  <th scope="col" className={styles.headCell}>
                    {c18.colToday}
                  </th>
                  <th scope="col" className={`${styles.headCell} ${uiStyles.tableHeadHighlight}`}>
                    {c.alternativeLabel}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <th scope="row" className={uiStyles.tableRowHead}>
                      {row.label}
                    </th>
                    <td className={row.strong ? uiStyles.tableStrong : undefined}>
                      <bdi dir="ltr">{formatShekel(row.today)}</bdi>
                    </td>
                    <td className={`${row.strong ? uiStyles.tableStrong : ''} ${uiStyles.tableHighlight}`}>
                      <bdi dir="ltr">{formatShekel(row.alternative)}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {c.difference !== undefined ? (
              <p className={styles.difference}>{differenceText(c.difference, fill)}</p>
            ) : null}
          </>
        ) : null}

        {c.status === 'missing' && (c.today || c.missingText.length > 0) ? (
          <>
            <p className={styles.listTitle}>{c18.missingTitle}</p>
            {c.today ? (
              <p className={styles.todayOnly}>
                {fill(c18.todayOnly, { amount: formatShekel(c.today.components.net) })}
              </p>
            ) : null}
            <Bullets title="" items={c.missingText} />
          </>
        ) : null}

        {c.status === 'ineligible' && c.eligibilityText ? (
          <>
            <p className={styles.listTitle}>{c18.ineligibleTitle}</p>
            <p className={styles.lineText}>{c.eligibilityText}</p>
          </>
        ) : null}

        {c.eligible === true && c.eligibilityText ? (
          <p className={styles.lineText}>
            <strong>{c18.eligibilityLabel}:</strong> {c.eligibilityText}
          </p>
        ) : null}

        <div className={styles.lines}>
          {explanationLines.map((line, index) => (
            <p key={`${index}-${line}`} className={styles.lineText}>
              {line}
            </p>
          ))}
        </div>

        {c.pendingQuestionId ? <p className={styles.waiting}>{c18.waitingForRep}</p> : null}

        <Bullets title={c18.unavailableTitle} items={c.unavailableText ?? []} />
        <Bullets title={c18.assumptionsTitle} items={c.assumptions} />

        {c.representativeEntered && c.representativeEntered.length > 0 ? (
          <div>
            <p className={styles.listTitle}>{c18.enteredByRepTitle}</p>
            <ul className={styles.bullets}>
              {c.representativeEntered.map((item) => (
                <li key={item.field}>
                  <Badge>{c18.repBadge}</Badge> {item.label}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {c.status === 'ok' ? <p className={styles.small}>{c18.estimateNote}</p> : null}
      </div>
    </Card>
  );
}
