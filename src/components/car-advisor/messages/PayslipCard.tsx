'use client';

import { useMemo, useState } from 'react';
import type { Payslip } from '../../../lib/payslip-schema';
import { validate } from '../../../lib/payslip-validate';
import { he } from '../content/he';
import styles from './api.module.css';

type Scalar = 'grossSalary' | 'carBenefitValue' | 'netToPay';
type Deduction = 'incomeTax' | 'nationalInsurance' | 'healthTax' | 'pensionEmployee' | 'studyFundEmployee';

const L = he.api.payslip;
const SCALARS: Scalar[] = ['grossSalary', 'carBenefitValue', 'netToPay'];
const DEDUCTIONS: Deduction[] = [
  'incomeTax',
  'nationalInsurance',
  'healthTax',
  'pensionEmployee',
  'studyFundEmployee',
];

const fmt = (n: number) => n.toLocaleString('he-IL', { maximumFractionDigits: 2 });
const parseNum = (v: string) => (v.trim() === '' || Number.isNaN(Number(v)) ? null : Number(v));

export interface PayslipCardProps {
  initialData: Payslip;
  disabled?: boolean;
  onConfirm: (data: Payslip) => void;
  onCancel: () => void;
}

/** Compact confirmation of what was read from the payslip. Edits stay in this card until "אישור". */
export function PayslipCard({ initialData, disabled = false, onConfirm, onCancel }: PayslipCardProps) {
  const [data, setData] = useState(initialData);
  const [editing, setEditing] = useState(false);
  const [touched, setTouched] = useState<Set<string>>(new Set());

  const warnings = useMemo(() => validate(data), [data]);

  const isLow = (path: string) =>
    !touched.has(path) && data.lowConfidenceFields.some((f) => f === path || f === path.split('.').pop());
  const touch = (path: string) => setTouched((s) => new Set(s).add(path));

  function row(label: string, path: string, value: number | null, set: (v: number | null) => void) {
    return (
      <div key={path} className={`${styles.payslipRow} ${isLow(path) ? styles.payslipRowLow : ''}`}>
        <dt>{label}</dt>
        {editing ? (
          <dd className={styles.payslipValue}>
            <input
              type="number"
              inputMode="decimal"
              step="any"
              aria-label={label}
              className={styles.payslipInput}
              value={value ?? ''}
              onChange={(e) => {
                touch(path);
                set(parseNum(e.target.value));
              }}
            />
          </dd>
        ) : (
          <dd className={styles.payslipValue}>{value == null ? L.notRead : `${fmt(value)} ₪`}</dd>
        )}
      </div>
    );
  }

  return (
    <div className={styles.payslipCard} role="group" aria-label={L.cardTitle}>
      <p className={styles.payslipTitle}>{L.cardTitle}</p>
      <p className={styles.payslipHint}>{L.cardHint}</p>

      {warnings.length > 0 ? (
        <ul role="alert" className={styles.payslipWarnings}>
          {warnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
        </ul>
      ) : null}

      <dl className={styles.payslipRows}>
        {SCALARS.map((k) => row(L.fields[k], k, data[k], (v) => setData((d) => ({ ...d, [k]: v }))))}
        {DEDUCTIONS.map((k) =>
          row(L.fields[k], `deductions.${k}`, data.deductions[k], (v) =>
            setData((d) => ({ ...d, deductions: { ...d.deductions, [k]: v } })),
          ),
        )}
        {data.deductions.other.map((o, i) =>
          row(o.name || L.otherDeduction, `deductions.other.${i}`, o.amount, (v) =>
            setData((d) => ({
              ...d,
              deductions: {
                ...d.deductions,
                other: d.deductions.other.map((x, j) => (j === i ? { ...x, amount: v ?? 0 } : x)),
              },
            })),
          ),
        )}
        {row(L.fields.taxCreditPoints, 'taxCreditPoints', data.taxCreditPoints, (v) =>
          setData((d) => ({ ...d, taxCreditPoints: v })),
        )}
      </dl>

      <div className={styles.payslipActions}>
        <button
          type="button"
          className={styles.payslipPrimary}
          disabled={disabled}
          onClick={() => onConfirm(data)}
        >
          {L.confirm}
        </button>
        <button
          type="button"
          className={styles.payslipSecondary}
          disabled={disabled}
          onClick={() => setEditing((e) => !e)}
        >
          {editing ? L.doneEditing : L.edit}
        </button>
        <button type="button" className={styles.payslipTertiary} disabled={disabled} onClick={onCancel}>
          {L.cancel}
        </button>
      </div>
    </div>
  );
}
