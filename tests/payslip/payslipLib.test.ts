import { describe, expect, it } from 'vitest';
import { he } from '../../src/components/car-advisor/content/he';
import { payslipSchema } from '../../src/lib/payslip-schema';
import { payslipToProfileFields } from '../../src/lib/payslip-to-engine';
import { isReconciled, validate } from '../../src/lib/payslip-validate';
import { fictionalPayslip } from './helpers';

const NOW = new Date('2026-04-10T00:00:00Z');

describe('payslipToProfileFields', () => {
  it('reconciled payslip: base = gross, commissions and bonus 0, percentages derived from the deductions', () => {
    const p = fictionalPayslip();
    expect(isReconciled(p)).toBe(true);
    expect(payslipToProfileFields(p)).toEqual({
      base: 20000,
      commissions: 0,
      bonus: 0,
      pensionPct: 6,
      studyFundPct: 1,
      creditPoints: 2.25,
    });
  });

  it('a pension / study fund line that is missing counts as 0 only when the payslip reconciles', () => {
    const reconciled = fictionalPayslip({
      netToPay: 16450,
      deductions: { incomeTax: 2200, nationalInsurance: 750, healthTax: 600, pensionEmployee: null, studyFundEmployee: null, other: [] },
    });
    expect(payslipToProfileFields(reconciled)).toMatchObject({ pensionPct: 0, studyFundPct: 0 });
    const notReconciled = fictionalPayslip({
      netToPay: 12000,
      deductions: { incomeTax: 2200, nationalInsurance: 750, healthTax: 600, pensionEmployee: null, studyFundEmployee: null, other: [] },
    });
    const out = payslipToProfileFields(notReconciled);
    expect(out.base).toBe(20000);
    expect('pensionPct' in out).toBe(false);
    expect('studyFundPct' in out).toBe(false);
  });

  it('values that were not read stay unknown (never guessed)', () => {
    const out = payslipToProfileFields(fictionalPayslip({ grossSalary: null, taxCreditPoints: null }));
    expect(out).toEqual({});
  });

  it('the derived percentage is rounded to 2 decimals and capped at 100', () => {
    const odd = fictionalPayslip({ deductions: { ...fictionalPayslip().deductions, pensionEmployee: 1186 } });
    expect(payslipToProfileFields(odd).pensionPct).toBe(5.93);
    const huge = fictionalPayslip({ deductions: { ...fictionalPayslip().deductions, pensionEmployee: 99999 } });
    expect(payslipToProfileFields(huge).pensionPct).toBe(100);
  });

  it('never returns a field the occupation / children / current car could come from', () => {
    const keys = Object.keys(payslipToProfileFields(fictionalPayslip()));
    expect(keys.sort()).toEqual(['base', 'bonus', 'commissions', 'creditPoints', 'pensionPct', 'studyFundPct'].sort());
  });

  it('car benefit (usage value) inside the gross is taken out of the base, so the engine does not count it twice', () => {
    const p = fictionalPayslip({ carBenefitValue: 1500 });
    const out = payslipToProfileFields(p);
    expect(out.base).toBe(18500);
    expect(out.pensionPct).toBe(6.49); // 1200 / 18500
  });

  it('a car benefit that is not below the gross cannot be right: the base stays unknown', () => {
    const out = payslipToProfileFields(fictionalPayslip({ carBenefitValue: 20000 }));
    expect('base' in out).toBe(false);
    expect('commissions' in out).toBe(false);
    expect(out.creditPoints).toBe(2.25);
  });
});

describe('validate', () => {
  it('no warning for a consistent, recent payslip', () => {
    expect(validate(fictionalPayslip(), NOW)).toEqual([]);
  });
  it('warns about a gross-to-net gap', () => {
    const w = validate(fictionalPayslip({ netToPay: 9000 }), NOW);
    expect(w).toHaveLength(1);
  });
  it('warns when the gross is missing', () => {
    expect(validate(fictionalPayslip({ grossSalary: null }), NOW)[0]).toContain('ברוטו');
  });
  it('warns about a month in the future or more than two years back', () => {
    expect(validate(fictionalPayslip({ payMonth: '2026-09' }), NOW)).toHaveLength(1);
    expect(validate(fictionalPayslip({ payMonth: '2023-01' }), NOW)).toHaveLength(1);
  });
});

describe('payslipSchema', () => {
  it('accepts the fictional payslip and rejects a malformed one', () => {
    expect(payslipSchema.safeParse(fictionalPayslip()).success).toBe(true);
    expect(payslipSchema.safeParse({ grossSalary: 'a lot' }).success).toBe(false);
  });
});

describe('payslip UI copy', () => {
  it('has a label for every field of the confirmation card', () => {
    for (const k of ['grossSalary', 'carBenefitValue', 'netToPay', 'incomeTax', 'nationalInsurance', 'healthTax', 'pensionEmployee', 'studyFundEmployee', 'taxCreditPoints'] as const) {
      expect(he.api.payslip.fields[k]).toBeTruthy();
    }
  });
});
