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
  /** Set when an open representative question affects this alternative. */
  pendingQuestionId?: string;
  meta?: ComparisonMeta;
}
