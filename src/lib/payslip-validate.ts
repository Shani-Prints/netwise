import type { Payslip } from './payslip-schema';

const TOLERANCE_ILS = 1;

const fmt = (n: number) => n.toLocaleString('he-IL', { maximumFractionDigits: 2 });

function totalDeductions(p: Payslip): number {
  const d = p.deductions;
  const fixed = [d.incomeTax, d.nationalInsurance, d.healthTax, d.pensionEmployee, d.studyFundEmployee];
  return fixed.reduce<number>((s, v) => s + (v ?? 0), 0) + d.other.reduce((s, o) => s + o.amount, 0);
}

/** Gross minus all deductions minus net-to-pay, or null when it cannot be computed (gross or net-to-pay missing). */
export function grossToNetGap(p: Payslip): number | null {
  if (p.grossSalary == null || p.netToPay == null) return null;
  return p.grossSalary - totalDeductions(p) - p.netToPay;
}

/** True only when gross, deductions and net-to-pay are all known and agree within the tolerance. */
export function isReconciled(p: Payslip): boolean {
  const gap = grossToNetGap(p);
  return gap !== null && Math.abs(gap) <= TOLERANCE_ILS;
}

export function validate(p: Payslip, now: Date = new Date()): string[] {
  const warnings: string[] = [];

  if (p.grossSalary == null) {
    warnings.push('לא זוהה שכר ברוטו בתלוש. יש להזין אותו ידנית.');
  } else {
    const gap = grossToNetGap(p);
    if (gap !== null && Math.abs(gap) > TOLERANCE_ILS) {
      warnings.push(
        `הברוטו פחות סך הניכויים שונה מהנטו לתשלום בפער של ${fmt(Math.abs(gap))} ₪. ייתכן שנקראו סכומים לא נכון או שחסר ניכוי.`,
      );
    }
  }

  if (p.payMonth) {
    const [y, m] = p.payMonth.split('-').map(Number);
    if (y !== undefined && m !== undefined) {
      const payIndex = y * 12 + (m - 1);
      const nowIndex = now.getFullYear() * 12 + now.getMonth();
      if (payIndex > nowIndex || nowIndex - payIndex > 24) {
        warnings.push('חודש התלוש נמצא בעתיד או לפני יותר משנתיים. ייתכן שהתאריך נקרא בצורה שגויה.');
      }
    }
  }

  return warnings;
}
