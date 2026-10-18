import { tierSplit } from './insurance';
import type { BracketLine, Breakdown, Rules } from './types';

/** Progressive tax on monthly taxable income before credits. Last bracket has no cap (limit null). */
export function bracketTax(taxable: number, brackets: Rules['netMethod']['brackets']): number {
  let tax = 0;
  let lower = 0;
  for (const [upper, rate] of brackets) {
    if (taxable <= lower) break;
    const top = upper === null ? taxable : Math.min(taxable, upper);
    tax += (top - lower) * rate;
    if (upper === null) break;
    lower = upper;
  }
  return tax;
}

/** Credit for the employee pension contribution: rate on the contribution, capped at maxRate of the ceiling. */
export function pensionCredit(pension: number, pc: Rules['netMethod']['pensionCredit']): number {
  return Math.min(pension, pc.incomeCeiling * pc.maxContributionRate) * pc.rate;
}

/** Income tax after credit points and pension credit; never negative. */
export function incomeTax(taxable: number, creditPoints: number, pension: number, rules: Rules): number {
  const m = rules.netMethod;
  const before = bracketTax(taxable, m.brackets);
  const credits = creditPoints * m.creditPointValue + pensionCredit(pension, m.pensionCredit);
  return Math.max(0, before - credits);
}

/** Bracket-by-bracket view of the same tax computation (explanation only; incomeTax remains the source of truth). */
export function taxBreakdown(taxable: number, creditPoints: number, pension: number, rules: Rules): Breakdown {
  const m = rules.netMethod;
  const brackets: BracketLine[] = [];
  let lower = 0;
  for (const [upper, rate] of m.brackets) {
    if (taxable <= lower) break;
    const top = upper === null ? taxable : Math.min(taxable, upper);
    const income = top - lower;
    brackets.push({ from: lower, to: upper, rate, income, tax: income * rate });
    if (upper === null) break;
    lower = upper;
  }
  const taxBeforeCredits = brackets.reduce((s, b) => s + b.tax, 0);
  const creditPointsCredit = creditPoints * m.creditPointValue;
  const pensionCreditAmount = pensionCredit(pension, m.pensionCredit);
  return {
    brackets,
    taxBeforeCredits,
    creditPointsCredit,
    pensionCredit: pensionCreditAmount,
    taxAfterCredits: Math.max(0, taxBeforeCredits - creditPointsCredit - pensionCreditAmount),
    nationalInsurance: tierSplit(taxable, m.nationalInsurance),
    health: tierSplit(taxable, m.health),
  };
}
