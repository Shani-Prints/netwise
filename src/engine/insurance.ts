import type { Rules, TierSplit } from './types';

type Tier = Rules['netMethod']['nationalInsurance'];

/** Two-tier contribution on min(taxable, ceiling): lowRate up to threshold, highRate above it. */
export function tieredContribution(taxable: number, tier: Tier): number {
  const base = Math.min(Math.max(taxable, 0), tier.ceiling);
  const low = Math.min(base, tier.threshold);
  const high = Math.max(0, base - tier.threshold);
  return low * tier.lowRate + high * tier.highRate;
}

export const nationalInsurance = (taxable: number, rules: Rules) =>
  tieredContribution(taxable, rules.netMethod.nationalInsurance);

export const healthInsurance = (taxable: number, rules: Rules) =>
  tieredContribution(taxable, rules.netMethod.health);

/** Low-tier and high-tier parts of the same contribution (explanation only). */
export function tierSplit(taxable: number, tier: Tier): TierSplit {
  const base = Math.min(Math.max(taxable, 0), tier.ceiling);
  const low = Math.min(base, tier.threshold);
  const high = Math.max(0, base - tier.threshold);
  return { base, low: low * tier.lowRate, high: high * tier.highRate };
}
