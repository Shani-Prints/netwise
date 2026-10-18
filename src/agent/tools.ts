import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { loadRules } from '../config/rules';
import { allowedCars, carLabel, getCatalogCar, getOccupation, loadCatalog, loadOccupations, toCarSpec } from '../data/catalog';
import { getUsageIndex, searchVehicles } from '../data/usageValues';
import type { Repo } from '../db/repo';
import type { OptionRef } from '../db/types';
import { checkEligibility, type EmployeeProfile } from '../engine';
import { eligibilityText, missingFieldLabel } from '../lib/explain';
import { ProfileFieldsSchema } from '../lib/schemas';
import {
  askRepresentativeParticipation,
  prepareEmployeeTurn,
  selectAlternative,
  ServiceError,
  updateProfile,
  type Actor,
} from '../lib/service';
import type { ComparisonView } from '../lib/view';
import { applyProvisionalPolicy } from './provisional';
import {
  AskRepOutputSchema,
  CatalogOutputSchema,
  ComparisonOutputSchema,
  EligibilityOutputSchema,
  SaveOutputSchema,
  UsageOutputSchema,
  type ToolError,
} from './schemas';

/** What happened in one turn: every validated tool output, in order, plus the last comparison shown to the user. */
export interface TurnCollector {
  results: { tool: string; output: unknown }[];
  lastView?: ComparisonView;
  /** True when a tool changed saved data or a representative question this turn. */
  touchedState: boolean;
}
export const newCollector = (): TurnCollector => ({ results: [], touchedState: false });

export interface ToolContext {
  repo: Repo;
  /** Built by the server from the verified session cookie. Tools take NO user id from arguments. */
  actor: Actor;
  collector: TurnCollector;
  showProvisional: boolean;
  /** PARTICIPATION_FROM_REPRESENTATIVE: only changes the wording of the ask_representative description. */
  participationFromRepresentative?: boolean;
}

// ---------------------------------------------------------------- input schemas (unknown keys, e.g. userId, are stripped)

const AlternativeArg = z
  .string()
  .min(1)
  .max(40)
  .describe('Catalogue car id such as "CAR-10", or the word "waiver" for giving up the car.');

export const SaveInputSchema = z.object({
  occupation: z.string().min(1).max(100).optional().describe('Exact occupation name from search_catalog(kind=occupations).'),
  group: z.enum(['א', 'ב', 'ג', 'ד']).optional().describe('Eligibility group.'),
  base: z.number().min(0).max(1_000_000).optional().describe('Monthly base salary, gross, in shekels.'),
  commissions: z.number().min(0).max(1_000_000).optional().describe('Monthly commissions, gross.'),
  bonus: z.number().min(0).max(1_000_000).optional().describe('Monthly bonus, gross.'),
  pensionPct: z.number().min(0).max(100).optional().describe('Employee pension percent.'),
  studyFundPct: z.number().min(0).max(100).optional().describe('Employee study fund percent.'),
  creditPoints: z.number().min(0).max(50).optional().describe('Tax credit points.'),
  childrenUnder23: z.number().int().min(0).max(30).optional().describe('Number of children up to the age limit in the rules.'),
  currentCarId: z.string().min(1).max(40).optional().describe('Current car: catalogue id, "waiver" or "none".'),
  currentCarDataset: z
    .object({
      makerCode: z.string().regex(/^\d{1,6}$/),
      modelCode: z.string().regex(/^\d{1,6}$/),
      vehicleTypeCode: z.string().regex(/^\d{1,3}$/),
      registrationYear: z.number().int().min(1990).max(2100),
    })
    .optional()
    .describe('Current car that is not in the catalogue, using the codes returned by get_usage_value.'),
  currentParticipation: z.number().min(0).max(20000).optional().describe("Employee's current monthly participation in the car."),
});

export const CatalogInputSchema = z.object({
  kind: z.enum(['allowed_cars', 'occupations']).describe('allowed_cars = cars this employee may choose; occupations = valid occupation names.'),
});
export const EligibilityInputSchema = z.object({ alternative: AlternativeArg });
export const UsageInputSchema = z.object({
  carId: z.string().min(1).max(40).optional().describe('Catalogue car id.'),
  maker: z.string().min(1).max(60).optional().describe('Maker name to search in the official dataset.'),
  model: z.string().min(1).max(60).optional().describe('Model name to search in the official dataset.'),
  registrationYear: z.number().int().min(1990).max(2100).optional(),
});
export const ComparisonInputSchema = z.object({ alternative: AlternativeArg });
export const AskRepInputSchema = z.object({
  alternative: z.string().min(1).max(40).describe('Catalogue car id whose employee participation is unknown.'),
});

// ---------------------------------------------------------------- helpers

const invalidArguments = (issues: { path: string; code: string }[]): ToolError => ({
  status: 'error',
  error: 'invalid_arguments',
  issues,
});

function toOptionRef(arg: string): OptionRef | null {
  if (arg === 'waiver') return { kind: 'waiver' };
  return getCatalogCar(arg) ? { kind: 'car', carId: arg } : null;
}
const unknownAlternative = (): ToolError => ({ status: 'error', error: 'unknown_car' });

/** Validate input -> run -> validate output -> record. A throw never escapes: it becomes a structured error. */
function defineTool<I extends z.ZodType, O extends z.ZodType>(
  ctx: ToolContext,
  name: string,
  description: string,
  input: I,
  output: O,
  run: (input: z.infer<I>) => Promise<z.infer<O>>,
) {
  return tool({
    description,
    inputSchema: input,
    execute: async (raw: unknown) => {
      let result: unknown;
      const parsed = input.safeParse(raw);
      if (!parsed.success) {
        result = invalidArguments(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), code: i.code })));
      } else {
        try {
          result = await run(parsed.data);
        } catch (err) {
          result = {
            status: 'error',
            error: err instanceof ServiceError ? err.code : 'tool_failed',
            ...(err instanceof ServiceError && Array.isArray(err.details) ? { issues: err.details } : {}),
          } satisfies ToolError;
        }
      }
      const checked = output.safeParse(result);
      const final: unknown = checked.success ? checked.data : ({ status: 'error', error: 'invalid_tool_output' } satisfies ToolError);
      ctx.collector.results.push({ tool: name, output: final });
      return final;
    },
  });
}

// ---------------------------------------------------------------- tools

export function createTools(ctx: ToolContext): ToolSet {
  const { repo, actor } = ctx;
  const rules = loadRules();

  const save_employee_data = defineTool(
    ctx,
    'save_employee_data',
    'Save facts the employee stated about themselves (any subset). Returns what is still missing for today\'s situation.',
    SaveInputSchema,
    SaveOutputSchema,
    async (a) => {
      const { currentCarId, currentCarDataset, ...rest } = a;
      const fields: Record<string, unknown> = { ...rest };
      if (currentCarId !== undefined) {
        fields.currentCar =
          currentCarId === 'waiver' || currentCarId === 'none'
            ? { kind: currentCarId }
            : { kind: 'car', carId: currentCarId };
      } else if (currentCarDataset) {
        fields.currentCar = { kind: 'dataset', ...currentCarDataset };
      }
      const valid = ProfileFieldsSchema.safeParse(fields);
      if (!valid.success) {
        return invalidArguments(valid.error.issues.map((i) => ({ path: i.path.map(String).join('.'), code: i.code })));
      }
      const state = await updateProfile(repo, actor, valid.data);
      ctx.collector.touchedState = true;
      const saved: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(a)) {
        if (v === undefined) continue;
        saved[k] = typeof v === 'object' ? 'dataset' : v;
      }
      const t = state.todayOnly;
      return {
        status: 'saved' as const,
        saved,
        missingFields: t.missingFields,
        missingText: t.missingText,
        ...(t.status === 'ok' && t.today ? { todayNet: t.today.components.net } : {}),
      };
    },
  );

  const search_catalog = defineTool(
    ctx,
    'search_catalog',
    'List valid occupation names, or the cars this employee may choose (needs group and children saved).',
    CatalogInputSchema,
    CatalogOutputSchema,
    async (a) => {
      if (a.kind === 'occupations') {
        return {
          status: 'ok' as const,
          cars: [],
          occupations: loadOccupations().map((o) => ({ name: o.name, group: o.group })),
          missingFields: [],
          missingText: [],
        };
      }
      const { profile } = await prepareEmployeeTurn(repo, actor);
      const need: string[] = [];
      if (!profile.groupCode) need.push('group');
      if (profile.childrenCount === undefined) need.push('childrenUnder23');
      if (need.length > 0 || !profile.groupCode || profile.childrenCount === undefined) {
        return {
          status: 'missing_fields' as const,
          cars: [],
          occupations: [],
          missingFields: need,
          missingText: need.map((f) => missingFieldLabel(f, rules.familyTrack.childMaxAge)),
        };
      }
      return {
        status: 'ok' as const,
        cars: allowedCars(profile.groupCode, profile.childrenCount, rules).map((c) => ({
          id: c.id,
          label: carLabel(c),
          group: c.group,
          drive: c.drive,
        })),
        occupations: [],
        missingFields: [],
        missingText: [],
      };
    },
  );

  const check_eligibility = defineTool(
    ctx,
    'check_eligibility',
    'Ask the rules engine whether the employee may choose this alternative. The only source for eligibility statements.',
    EligibilityInputSchema,
    EligibilityOutputSchema,
    async (a) => {
      const ref = toOptionRef(a.alternative);
      if (!ref) return unknownAlternative();
      const { profile } = await prepareEmployeeTurn(repo, actor);
      const car = ref.kind === 'car' ? getCatalogCar(ref.carId) : undefined;
      const label = ref.kind === 'waiver' ? 'ויתור על רכב' : car ? carLabel(car) : a.alternative;
      const need: string[] = [];
      if (!profile.occupation) need.push('occupation');
      if (!profile.groupCode) need.push('group');
      if (car?.group === 'family' && profile.childrenCount === undefined) need.push('childrenUnder23');
      const occupation = profile.occupation ? getOccupation(profile.occupation) : undefined;
      if (need.length > 0 || !occupation || !profile.groupCode) {
        return {
          status: 'missing_fields' as const,
          alternativeLabel: label,
          text: 'לא ניתן לקבוע זכאות עד להשלמת המידע החסר',
          missingFields: need,
          missingText: need.map((f) => missingFieldLabel(f, rules.familyTrack.childMaxAge)),
        };
      }
      const option = ref.kind === 'waiver' ? ({ kind: 'waiver' } as const) : { kind: 'car' as const, car: toCarSpec(car!, getUsageIndex()) };
      const e = checkEligibility(
        { group: profile.groupCode, occupation: occupation.name, childrenUnder23: profile.childrenCount ?? 0 } as EmployeeProfile,
        occupation,
        option,
        rules,
      );
      return {
        status: e.eligible ? ('eligible' as const) : ('ineligible' as const),
        alternativeLabel: label,
        text: eligibilityText(e),
        missingFields: [],
        missingText: [],
      };
    },
  );

  const get_usage_value = defineTool(
    ctx,
    'get_usage_value',
    'Official monthly usage value (שווי שימוש) of a car, from the dataset. Give carId, or maker/model(/registrationYear) to search.',
    UsageInputSchema,
    UsageOutputSchema,
    async (a) => {
      const index = getUsageIndex();
      if (a.carId) {
        const c = getCatalogCar(a.carId);
        if (!c) return unknownAlternative();
        const spec = toCarSpec(c, index);
        return {
          status: 'found' as const,
          matches: [
            {
              label: carLabel(c),
              carId: c.id,
              registrationYear: c.registrationYear,
              usageValue: spec.usageValue,
              makerCode: c.makerCode,
              modelCode: c.modelCode,
              vehicleTypeCode: c.vehicleTypeCode,
            },
          ],
        };
      }
      if (!a.maker && !a.model) return invalidArguments([{ path: 'carId', code: 'missing_search' }]);
      const rows = searchVehicles(index, { maker: a.maker, model: a.model, registrationYear: a.registrationYear }, 8);
      const catalog = loadCatalog();
      return {
        status: rows.length > 0 ? ('found' as const) : ('not_found' as const),
        matches: rows.map((r) => ({
          label: `${r.makerName} ${r.commercialName || r.modelDescription} (${r.registrationYear})`,
          carId: catalog.find(
            (c) => c.makerCode === r.makerCode && c.modelCode === r.modelCode && c.registrationYear === r.registrationYear && c.vehicleTypeCode === r.vehicleTypeCode,
          )?.id,
          registrationYear: r.registrationYear,
          usageValue: r.usageValue,
          makerCode: r.makerCode,
          modelCode: r.modelCode,
          vehicleTypeCode: r.vehicleTypeCode,
        })),
      };
    },
  );

  const calculate_comparison = defineTool(
    ctx,
    'calculate_comparison',
    'Compare the employee\'s net today with one alternative, using the real engine. Returns numbers, or missing_fields, or ineligible. Never guess a number.',
    ComparisonInputSchema,
    ComparisonOutputSchema,
    async (a) => {
      const ref = toOptionRef(a.alternative);
      if (!ref) return unknownAlternative();
      const state = await selectAlternative(repo, actor, ref);
      ctx.collector.touchedState = true;
      const raw = state.comparison;
      if (!raw) return { status: 'error' as const, error: 'no_comparison' };
      const view = applyProvisionalPolicy(raw, ctx.showProvisional);
      ctx.collector.lastView = view;
      const base = {
        alternativeLabel: view.alternativeLabel,
        eligibilityText: view.eligibilityText,
        explanation: view.explanation,
        assumptions: view.assumptions,
        pendingRepresentative: view.pendingQuestionId !== undefined,
        missingFields: view.missingFields,
        missingText: view.missingText,
      };
      if (view.status === 'ok' && view.today && view.alternative) {
        return {
          ...base,
          status: 'ok' as const,
          todayNet: view.today.components.net,
          alternativeNet: view.alternative.components.net,
          ...(view.difference !== undefined ? { difference: Math.abs(view.difference) } : {}),
        };
      }
      if (view.status === 'missing' && view.today && view.pendingQuestionId) {
        return { ...base, status: 'awaiting_representative' as const, todayNet: view.today.components.net };
      }
      return { ...base, status: view.status === 'ineligible' ? ('ineligible' as const) : ('missing_fields' as const) };
    },
  );

  const ask_representative = defineTool(
    ctx,
    'ask_representative',
    ctx.participationFromRepresentative
      ? 'Ask the transport representative for the employee\'s participation in the new car, when the employee cannot know it. In this mode the server also opens this question automatically after a comparison. The question text is fixed by the server.'
      : 'Ask the transport representative to CONFIRM the employee\'s participation in one specific catalogue car. By default the participation is the catalogue default, so do NOT call this tool for it and never say you asked the representative about it. Call it ONLY if the employee explicitly asks for a representative-confirmed value, or for a real missing value that has no default. The question text is fixed by the server.',
    AskRepInputSchema,
    AskRepOutputSchema,
    async (a) => {
      const r = await askRepresentativeParticipation(repo, actor, a.alternative);
      ctx.collector.touchedState = true;
      const note =
        r.status === 'already_answered'
          ? 'הנציג כבר ענה על השאלה הזו.'
          : r.status === 'already_open'
            ? 'השאלה לנציג כבר נשלחה וממתינה לתשובה.'
            : 'שאלה נשלחה לנציג התחבורה.';
      return { status: r.status, note };
    },
  );

  return { save_employee_data, search_catalog, check_eligibility, get_usage_value, calculate_comparison, ask_representative };
}
