import { loadRules } from '../config/rules';
import { DEFAULT_ELECTRIC_DRIVE_LABEL, type Rules } from '../config/rulesSchema';
import { carLabel, getCatalogCar, getOccupation, toCarSpec } from '../data/catalog';
import { getUsageIndex, lookupUsageValue, type UsageIndex } from '../data/usageValues';
import type { ConversationState, OptionRef, ProfileRecord } from '../db/types';
import {
  calculateScenario,
  compareScenarios,
  displayDifference,
  findMissingFields,
  roundShekel,
  type CarSpec,
  type Components,
  type ComparisonInput,
  type ComparisonResult,
  type EmployeeProfile,
  type ScenarioOption,
  type ScenarioResult,
} from '../engine';
import { eligibilityText, explainResult, fmt, missingFieldLabel } from './explain';
import { participationFromRepresentative } from './flags';
import type { ComponentsView, ComparisonView, ScenarioView } from './view';

export type ParticipationSource = 'representative' | 'catalog_default' | 'not_applicable';

export interface BuildComparisonArgs {
  profile: ProfileRecord | null;
  state: ConversationState;
  alternative: OptionRef;
  rules?: Rules;
  usage?: UsageIndex;
  /** Overrides PARTICIPATION_FROM_REPRESENTATIVE (tests). Default: read the env flag. */
  participationFromRepresentative?: boolean;
}

export interface BuiltComparison {
  view: ComparisonView;
  /** Raw engine result (server side only; the view carries the rounded numbers). */
  result: ComparisonResult;
  input: ComparisonInput;
  /**
   * Where the new car's employee participation came from: the catalogue default (demo data) unless a representative
   * has explicitly answered.
   */
  participationSource: ParticipationSource;
  /**
   * True only in representative mode (PARTICIPATION_FROM_REPRESENTATIVE=true) while the participation is still the
   * catalogue default: the service then opens a representative question. Always false in the default mode.
   */
  needsRepresentative: boolean;
}

const WAIVER_LABEL = 'ויתור על רכב';

const roundComponents = (c: Components): ComponentsView => ({
  gross: roundShekel(c.gross),
  taxableBase: roundShekel(c.taxableBase),
  usageValue: roundShekel(c.usageValue),
  maintenance: roundShekel(c.maintenance),
  evGrossUp: roundShekel(c.evGrossUp),
  tax: roundShekel(c.tax),
  nationalInsurance: roundShekel(c.nationalInsurance),
  health: roundShekel(c.health),
  pension: roundShekel(c.pension),
  studyFund: roundShekel(c.studyFund),
  participation: roundShekel(c.participation),
  familyShare: roundShekel(c.familyShare),
  net: roundShekel(c.net),
});

const toScenarioView = (s: ScenarioResult): ScenarioView => ({
  label: s.label,
  components: roundComponents(s.components),
  costVsBudget: s.costVsBudget
    ? {
        cost: roundShekel(s.costVsBudget.cost),
        budget: roundShekel(s.costVsBudget.budget),
        difference: roundShekel(s.costVsBudget.difference),
      }
    : null,
});

/** The employee's current situation, from saved state. undefined = not known yet (engine reports it missing). */
function resolveToday(
  state: ConversationState,
  group: EmployeeProfile['group'] | undefined,
  rules: Rules,
  usage: UsageIndex,
): ScenarioOption | undefined {
  const cur = state.currentCar;
  if (!cur) return undefined;
  if (cur.kind === 'waiver') return { kind: 'waiver' };
  if (cur.kind === 'none') return { kind: 'none' };
  if (cur.kind === 'car') {
    const c = getCatalogCar(cur.carId);
    if (!c) return undefined;
    return { kind: 'car', car: toCarSpec(c, usage), employeeParticipation: state.currentParticipation };
  }
  // A car outside the catalogue, identified only by dataset keys: the usage value is looked up, never supplied.
  const hit = lookupUsageValue(usage, {
    registrationYear: cur.registrationYear,
    makerCode: cur.makerCode,
    modelCode: cur.modelCode,
    vehicleTypeCode: cur.vehicleTypeCode,
  });
  if (hit.status !== 'found') return undefined;
  const car: CarSpec = {
    id: `dataset:${hit.datasetRowId}`,
    name: cur.label,
    group: group ?? 'א', // not used for the current car (only family-track cars use their group)
    monthlyCost: 0,
    usageValue: hit.row.usageValue,
    isElectric:
      rules.valueOfUse.driveField[String(hit.row.driveCode)] ===
      (rules.valueOfUse.electricDriveLabel ?? DEFAULT_ELECTRIC_DRIVE_LABEL),
    defaultParticipation: 0,
  };
  return { kind: 'car', car, employeeParticipation: state.currentParticipation };
}

/** Saved profile -> engine profile. Missing values stay undefined so the engine reports them as missing. */
function profileInputOf(profile: ProfileRecord | null): Partial<EmployeeProfile> {
  const s = profile?.salaryInputs ?? {};
  return {
    group: profile?.groupCode,
    occupation: profile?.occupation,
    base: s.base,
    commissions: s.commissions,
    bonus: s.bonus,
    pensionPct: s.pensionPct,
    studyFundPct: s.studyFundPct,
    creditPoints: s.creditPoints,
    childrenUnder23: profile?.childrenCount,
  };
}

export interface TodayOnly {
  status: 'ok' | 'missing';
  today?: ScenarioView;
  missingFields: string[];
  missingText: string[];
}

/**
 * What can already be computed without any alternative: the employee's net for today's situation.
 * Used while a representative question is open. Returns missing (never a number) if today's inputs are incomplete.
 */
export function buildTodayOnly(args: Omit<BuildComparisonArgs, 'alternative'>): TodayOnly {
  const rules = args.rules ?? loadRules();
  const usage = args.usage ?? getUsageIndex();
  const { profile, state } = args;
  const profileInput = profileInputOf(profile);
  const occupation = profile?.occupation ? getOccupation(profile.occupation) : undefined;
  const today = resolveToday(state, profile?.groupCode, rules, usage);
  // An alternative of kind "none" needs nothing, so only profile / occupation / today inputs can be reported missing.
  const missing = findMissingFields({ profile: profileInput, occupation, today, alternative: { kind: 'none' } });
  if (missing.length > 0 || !occupation || !today) {
    const fields = missing.length > 0 ? missing : ['currentCar'];
    return {
      status: 'missing',
      missingFields: fields,
      missingText: [...new Set(fields.map((f) => missingFieldLabel(f, rules.familyTrack.childMaxAge)))],
    };
  }
  const scenario = calculateScenario(profileInput as EmployeeProfile, occupation, today, rules);
  return { status: 'ok', today: toScenarioView(scenario), missingFields: [], missingText: [] };
}

/**
 * Builds the comparison "today vs one alternative" from saved conversation state + profile.
 * Participation of the new car: a representative's answer wins; otherwise the catalogue default is used and the
 * result is flagged as an assumption pending confirmation. The LLM never supplies any number here.
 */
export function buildComparison(args: BuildComparisonArgs): BuiltComparison {
  const rules = args.rules ?? loadRules();
  const usage = args.usage ?? getUsageIndex();
  const { profile, state, alternative } = args;
  const profileInput = profileInputOf(profile);

  let altOption: ScenarioOption | undefined;
  let altLabel = WAIVER_LABEL;
  let source: ParticipationSource = 'not_applicable';
  if (alternative.kind === 'waiver') {
    altOption = { kind: 'waiver' };
  } else {
    const c = getCatalogCar(alternative.carId);
    altLabel = c ? carLabel(c) : alternative.carId;
    if (c) {
      const answered = state.repAnswers[c.id];
      source = answered !== undefined ? 'representative' : 'catalog_default';
      altOption = {
        kind: 'car',
        car: toCarSpec(c, usage),
        employeeParticipation: answered ?? c.defaultParticipation,
      };
    }
  }

  const input: ComparisonInput = {
    profile: profileInput,
    occupation: profile?.occupation ? getOccupation(profile.occupation) : undefined,
    today: resolveToday(state, profile?.groupCode, rules, usage),
    alternative: altOption,
  };
  const result = compareScenarios(input, rules);
  const childMaxAge = rules.familyTrack.childMaxAge;
  const explanation = explainResult(result, altLabel, childMaxAge);

  const repMode = args.participationFromRepresentative ?? participationFromRepresentative();
  const needsRepresentative = repMode && source === 'catalog_default';
  const assumptions: string[] = [];
  if (result.status === 'ok' && source === 'catalog_default') {
    const amount = fmt(result.alternative.components.participation);
    assumptions.push(
      repMode
        ? `השתתפות העובד ברכב החדש (${amount} ₪) היא ברירת המחדל של הקטלוג וטרם אושרה על ידי נציג התחבורה.`
        : `השתתפות העובד ברכב החדש (${amount} ₪) נלקחה מברירת המחדל בקטלוג (נתוני הדגמה).`,
    );
  }

  const base = {
    alternativeRef: alternative,
    explanation,
    assumptions,
  };
  let view: ComparisonView;
  if (result.status === 'ok') {
    view = {
      ...base,
      status: 'ok',
      alternativeLabel: result.alternative.label,
      eligible: true,
      eligibilityText: eligibilityText(result.eligibility),
      today: toScenarioView(result.today),
      alternative: toScenarioView(result.alternative),
      difference: displayDifference(result.today.components.net, result.alternative.components.net),
      missingFields: [],
      missingText: [],
      meta: {
        rulesVersion: result.meta.rulesVersion,
        effectiveDate: result.meta.effectiveDate,
        taxYear: result.meta.taxYear,
        usageDatasetVersion: usage.datasetVersion,
      },
    };
  } else if (result.status === 'ineligible') {
    view = {
      ...base,
      status: 'ineligible',
      alternativeLabel: altLabel,
      eligible: false,
      eligibilityText: eligibilityText(result.eligibility),
      missingFields: [],
      missingText: [],
      meta: {
        rulesVersion: result.meta.rulesVersion,
        effectiveDate: result.meta.effectiveDate,
        taxYear: result.meta.taxYear,
        usageDatasetVersion: usage.datasetVersion,
      },
    };
  } else {
    view = {
      ...base,
      status: 'missing',
      alternativeLabel: altLabel,
      eligible: null,
      eligibilityText: 'לא ניתן לקבוע זכאות עד להשלמת המידע החסר',
      missingFields: result.missingFields,
      missingText: [...new Set(result.missingFields.map((f) => missingFieldLabel(f, childMaxAge)))],
    };
  }

  return { view, result, input, participationSource: source, needsRepresentative };
}
