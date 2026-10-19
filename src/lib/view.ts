import type { OptionRef } from '../db/types';

/** All amounts here are already rounded to whole shekels (display layer). Raw engine numbers never leave the server. */
export interface ComponentsView {
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

export interface ScenarioView {
  label: string;
  components: ComponentsView;
  costVsBudget: { cost: number; budget: number; difference: number } | null;
}

export interface ComparisonMeta {
  rulesVersion: string;
  effectiveDate: string | null;
  taxYear: number;
  usageDatasetVersion: string;
}

export interface ComparisonView {
  status: 'ok' | 'ineligible' | 'missing';
  alternativeRef: OptionRef;
  alternativeLabel: string;
  /** null when it could not be determined (missing data). */
  eligible: boolean | null;
  eligibilityText: string;
  today?: ScenarioView;
  alternative?: ScenarioView;
  /** Displayed alternative net minus displayed current net. */
  difference?: number;
  /** Exactly two plain-Hebrew lines. */
  explanation: string[];
  assumptions: string[];
  missingFields: string[];
  missingText: string[];
  /** Set when an open representative question blocks (or affects) this comparison: the missing part is waiting for it. */
  pendingQuestionId?: string;
  /**
   * Inputs of this comparison whose value was entered by a representative, not by the employee.
   * The UI shows REPRESENTATIVE_BADGE_HE ("הוזן על ידי נציג") next to them. The employee can still correct them.
   */
  representativeEntered?: { field: string; label: string }[];
  /** Hebrew reasons for inputs that will NOT become available (the representative could not provide them). The comparison stays missing. */
  unavailableText?: string[];
  meta?: ComparisonMeta;
}

export const REPRESENTATIVE_BADGE_HE = 'הוזן על ידי נציג';
