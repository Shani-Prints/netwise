import type { GroupCode, Rules } from '../config/rulesSchema';

export type { GroupCode, Rules };
export type CarGroup = GroupCode | 'family';

export interface CarSpec {
  id: string;
  name: string;
  group: CarGroup;
  /** Monthly cost to the company (catalogue). */
  monthlyCost: number;
  /** Monthly usage value (שווי שימוש) already resolved from the official dataset. */
  usageValue: number;
  isElectric: boolean;
  defaultParticipation: number;
}

export interface OccupationSpec {
  name: string;
  group: GroupCode;
  carMandatory: boolean;
  waiverAllowed: boolean;
  maintenance: number;
}

export interface EmployeeProfile {
  group: GroupCode;
  occupation: string;
  base: number;
  commissions: number;
  bonus: number;
  pensionPct: number;
  studyFundPct: number;
  creditPoints: number;
  childrenUnder23: number;
}

/** What an employee has (today) or would have (alternative). */
export type ScenarioOption =
  | { kind: 'car'; car: CarSpec; employeeParticipation?: number }
  | { kind: 'waiver' }
  | { kind: 'none' };

export interface Reason {
  /** Machine-readable code; the explanation text is built from code + params. */
  code: string;
  params?: Record<string, number | string>;
}

export interface Components {
  gross: number;
  taxableBase: number;
  usageValue: number;
  maintenance: number;
  evGrossUp: number;
  tax: number;
  nationalInsurance: number;
  health: number;
  pension: number;
  studyFund: number;
  participation: number;
  familyShare: number;
  net: number;
}

/** One income-tax bracket as applied to the taxable amount (only brackets that were reached). */
export interface BracketLine {
  from: number;
  /** null = the uncapped top bracket. */
  to: number | null;
  rate: number;
  /** Part of the taxable income that falls in this bracket. */
  income: number;
  tax: number;
}

export interface TierSplit {
  /** min(taxable, ceiling): the base the tiers apply to. */
  base: number;
  low: number;
  high: number;
}

/** Read-only explanation of how tax / NI / health in `components` were obtained. Does not feed any calculation. */
export interface Breakdown {
  brackets: BracketLine[];
  taxBeforeCredits: number;
  creditPointsCredit: number;
  pensionCredit: number;
  /** max(0, taxBeforeCredits - credits): equals components.tax. */
  taxAfterCredits: number;
  nationalInsurance: TierSplit;
  health: TierSplit;
}

export interface ScenarioResult {
  option: ScenarioOption;
  label: string;
  components: Components;
  breakdown: Breakdown;
  /** Cost vs the employee's group budget (cars only). Unused budget is never paid as cash. */
  costVsBudget: { cost: number; budget: number; difference: number } | null;
  reasons: Reason[];
}

export interface Eligibility {
  eligible: boolean;
  reasons: Reason[];
}

export interface ResultMeta {
  rulesVersion: string;
  effectiveDate: string | null;
  taxYear: number;
}

export interface ComparisonInput {
  profile: Partial<EmployeeProfile>;
  occupation?: OccupationSpec;
  today?: ScenarioOption;
  alternative?: ScenarioOption;
}

export type ComparisonResult =
  | {
      status: 'ok';
      meta: ResultMeta;
      eligibility: Eligibility;
      today: ScenarioResult;
      alternative: ScenarioResult;
      /** alternative.net - today.net (unrounded). */
      difference: number;
      reasons: Reason[];
    }
  | { status: 'ineligible'; meta: ResultMeta; eligibility: Eligibility }
  | { status: 'missing'; missingFields: string[]; conflicts: Reason[] };
