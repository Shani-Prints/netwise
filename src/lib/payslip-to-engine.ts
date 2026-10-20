import type { Payslip } from './payslip-schema';
import { isReconciled } from './payslip-validate';

/** The subset of the engine's profile fields (ProfileFields in src/lib/schemas.ts) that a payslip can fill. */
export interface PayslipProfileFields {
  base?: number;
  commissions?: number;
  bonus?: number;
  pensionPct?: number;
  studyFundPct?: number;
  creditPoints?: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Maps an approved payslip to the profile fields the calculation engine already accepts.
 *  - The gross already includes every pay component, so the cash gross is the base and commissions / bonus are 0. The cash gross is
 *    the payslip gross minus the car benefit (usage value) line when the payslip has one: the engine adds the usage value itself,
 *    so leaving it inside the base would count it twice. A car benefit that is not below the gross cannot be right: the base then
 *    stays unknown so that the bot asks for it.
 *  - A pension / study-fund deduction that is missing from the payslip counts as 0 only when gross, all deductions and
 *    net-to-pay add up (within 1 ILS); otherwise it stays unknown so that the bot asks for it.
 *  - Other missing values are omitted, never guessed.
 */
export function payslipToProfileFields(p: Payslip): PayslipProfileFields {
  const out: PayslipProfileFields = {};
  const payslipGross = p.grossSalary;
  const carBenefit = p.carBenefitValue != null && p.carBenefitValue > 0 ? p.carBenefitValue : 0;
  const gross = payslipGross != null && carBenefit < payslipGross ? round2(payslipGross - carBenefit) : null;
  if (gross != null && gross >= 0) {
    const reconciled = isReconciled(p);
    const pct = (part: number | null): number | undefined => {
      if (part != null) return gross > 0 ? Math.min(100, round2((part / gross) * 100)) : undefined;
      return reconciled ? 0 : undefined;
    };
    out.base = gross;
    out.commissions = 0;
    out.bonus = 0;
    const pension = pct(p.deductions.pensionEmployee);
    if (pension !== undefined) out.pensionPct = pension;
    const studyFund = pct(p.deductions.studyFundEmployee);
    if (studyFund !== undefined) out.studyFundPct = studyFund;
  }
  if (p.taxCreditPoints != null && p.taxCreditPoints >= 0) out.creditPoints = p.taxCreditPoints;
  return out;
}
