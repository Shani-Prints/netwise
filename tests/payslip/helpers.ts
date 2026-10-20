import type { Payslip } from '../../src/lib/payslip-schema';

/** A FICTIONAL payslip (invented numbers). gross 20,000 - deductions 4,950 = net to pay 15,050. */
export function fictionalPayslip(over: Partial<Payslip> = {}): Payslip {
  return {
    payMonth: '2026-03',
    grossSalary: 20000,
    netSalary: 15050,
    netToPay: 15050,
    deductions: {
      incomeTax: 2200,
      nationalInsurance: 750,
      healthTax: 600,
      pensionEmployee: 1200,
      studyFundEmployee: 200,
      other: [],
    },
    taxCreditPoints: 2.25,
    carBenefitValue: null,
    lowConfidenceFields: [],
    ...over,
  };
}
