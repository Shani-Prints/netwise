'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { fill } from '../content/fill';
import { he } from '../content/he';
import type { ApiComparison } from '../contract/types';
import { DocumentIcon } from '../ui/Icons';
import styles from './summary.module.css';
import apiStyles from './api.module.css';
import { comparisonRows, differenceText, formatShekel } from './comparisonFormat';

const L = he.api.comparison;
const S = L.summary;

/** The summary is offered only for a comparison with numbers (status ok). */
export function canSummarize(comparison: ApiComparison): boolean {
  return comparison.status === 'ok' && comparison.today !== undefined && comparison.alternative !== undefined;
}

// A sentence that invites the reader to type something in the chat ("אם זו לא השנה הנכונה, אפשר לכתוב את השנה") means nothing on paper.
const INVITATION = /אפשר|ניתן ל/u;

/** The factual part of an assumption: the sentences that invite a reply in the chat are dropped (the card keeps them). */
export function withoutInvitation(text: string): string {
  const sentences = text.match(/[^.!?]+[.!?]*/gu) ?? [text];
  return sentences.filter((sentence) => !INVITATION.test(sentence)).join('').trim();
}

/**
 * The one-page summary of a comparison. It re-presents what the card shows, from the same ApiComparison of the turn:
 * nothing is computed here, and nothing personal (name, ID, file name, payslip content) is part of that object.
 */
export function ComparisonSummary({ comparison, date }: { comparison: ApiComparison; date: string }) {
  const c = comparison;
  const rows = comparisonRows(c);
  const lines = c.explanation.slice(1);
  const assumptions = c.assumptions.map(withoutInvitation).filter((a) => a !== '');
  const provenance = [
    ...(c.payslipEntered && c.payslipEntered.length > 0 ? [`${L.fromPayslipTitle}: ${c.payslipEntered.join(', ')}`] : []),
    ...(c.representativeEntered ?? []).map((item) => `${L.enteredByRepTitle}: ${item.label}`),
    S.sourceEmployee,
  ];
  return (
    <div>
      <h1 className={styles.title}>{S.title}</h1>
      <p className={styles.date}>
        {S.dateLabel}: {date}
      </p>
      <p className={styles.meta}>
        {S.currentCar}: {c.today?.label}
      </p>
      <p className={styles.meta}>
        {S.comparedCar}: {c.alternativeLabel}
      </p>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{L.colItem}</th>
            <th scope="col">{L.colToday}</th>
            <th scope="col">{c.alternativeLabel}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className={row.strong ? styles.strong : undefined}>
              <th scope="row">{row.label}</th>
              <td>
                <bdi dir="ltr">{formatShekel(row.today)}</bdi>
              </td>
              <td>
                <bdi dir="ltr">{formatShekel(row.alternative)}</bdi>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {c.difference !== undefined ? <p className={styles.difference}>{differenceText(c.difference, fill)}</p> : null}
      {c.eligible === true && c.eligibilityText ? (
        <p className={styles.text}>
          <strong>{L.eligibilityLabel}:</strong> {c.eligibilityText}
        </p>
      ) : null}
      {lines.map((line, index) => (
        <p key={`${index}-${line}`} className={styles.text}>
          {line}
        </p>
      ))}
      {assumptions.length > 0 ? (
        <>
          <h2 className={styles.sectionTitle}>{L.assumptionsTitle}</h2>
          <ul className={styles.list}>
            {assumptions.map((item, index) => (
              <li key={`${index}-${item}`}>{item}</li>
            ))}
          </ul>
        </>
      ) : null}
      <h2 className={styles.sectionTitle}>{S.sourcesTitle}</h2>
      <ul className={styles.list}>
        {provenance.map((item, index) => (
          <li key={`${index}-${item}`}>{item}</li>
        ))}
      </ul>
      <p className={styles.disclaimer}>
        {L.estimateNote} {S.disclaimer}
      </p>
    </div>
  );
}

/** The "save summary" button of the action row, and the printable view it opens. Printing is the browser's: nothing is sent or stored. */
export function SummaryAction({ comparison }: { comparison: ApiComparison }) {
  const [open, setOpen] = useState(false);
  if (!canSummarize(comparison)) return null;
  return (
    <>
      <button type="button" className={`${apiStyles.carChoiceButton} ${apiStyles.carChoiceButtonPrimary}`} onClick={() => setOpen(true)}>
        <DocumentIcon size={16} />
        {S.button}
      </button>
      {open
        ? createPortal(
            <div className={styles.overlay} data-print-summary="" role="dialog" aria-modal="true" aria-label={S.dialogLabel}>
              <div className={styles.sheet} dir="rtl" lang="he">
                <div className={styles.toolbar}>
                  <button type="button" className={`${styles.toolbarButton} ${styles.toolbarPrimary}`} onClick={() => window.print()}>
                    {S.print}
                  </button>
                  <button type="button" className={styles.toolbarButton} onClick={() => setOpen(false)}>
                    {S.close}
                  </button>
                </div>
                <ComparisonSummary comparison={comparison} date={new Date().toLocaleDateString('he-IL')} />
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
