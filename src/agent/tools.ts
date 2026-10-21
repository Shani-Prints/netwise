import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { GroupCode } from '../config/rulesSchema';
import { carLabel, getCatalogCar, getOccupation, loadCatalog, loadOccupations, toCarSpec } from '../data/catalog';
import { matchCatalogCar } from '../data/carMatch';
import { matchOccupation } from '../data/occupationMatch';
import { getUsageIndex, searchVehicles } from '../data/usageValues';
import type { Repo } from '../db/repo';
import type { OptionRef } from '../db/types';
import { ProfileFieldsSchema, type ProfileFields } from '../lib/schemas';
import { UNKNOWABLE_FIELDS } from '../lib/repQuestions';
import { STATUS_TEXT } from '../lib/repTemplates';
import {
  listQuestionStatus,
  noteRejectedFields,
  noteUnresolved,
  prepareEmployeeTurn,
  provideEmployeeReference,
  reportUnknownFields,
  selectAlternative,
  ServiceError,
  updateProfile,
  type Actor,
  type EscalationReply,
} from '../lib/service';
import type { ComparisonView } from '../lib/view';
import { askBatchLabels } from './askNext';
import { runEligibilityCheck } from './eligibilityCheck';
import { PROVENANCE_FIELDS, checkProvenance, statedFieldValue, type ProvenanceField } from './provenance';
import { listAllowedOptions } from './eligibleCars';
import { applyProvisionalPolicy } from './provisional';
import {
  AskRepOutputSchema,
  CatalogOutputSchema,
  ComparisonOutputSchema,
  EligibilityOutputSchema,
  EscalationOutputSchema,
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
  /** Questions the SERVER opened (or queued) during this turn, as reported to the tools. */
  escalations: { kind: string; field: string; outcome: string }[];
}
export const newCollector = (): TurnCollector => ({ results: [], touchedState: false, escalations: [] });

export interface ToolContext {
  repo: Repo;
  /** Built by the server from the verified session cookie. Tools take NO user id from arguments. */
  actor: Actor;
  collector: TurnCollector;
  showProvisional: boolean;
  /** PARTICIPATION_FROM_REPRESENTATIVE: only changes the wording of the ask_representative description. */
  participationFromRepresentative?: boolean;
  /**
   * The employee's conversation. save_employee_data checks every numeric value against the employee's OWN messages in it;
   * without it numeric fields cannot be verified and are refused (fail closed).
   */
  conversationId?: string;
}

// ---------------------------------------------------------------- input schemas (unknown keys, e.g. userId, are stripped)

const AlternativeArg = z
  .string()
  .min(1)
  .max(80)
  .describe('Catalogue car id such as "CAR-10" (from carIdsInternal), or the word "waiver" for giving up the car.');

export const SaveInputSchema = z.object({
  occupation: z.string().min(1).max(100).optional().describe('Exact occupation name from search_catalog(kind=occupations).'),
  group: z.enum(['א', 'ב', 'ג', 'ד']).optional().describe('Eligibility group.'),
  base: z.number().min(0).max(1_000_000).optional().describe('Monthly base salary, gross, in shekels (0-1,000,000). 18,500 or 18500 -> 18500.'),
  commissions: z.number().min(0).max(1_000_000).optional().describe('Monthly commissions, gross (0-1,000,000). "no commissions" -> 0.'),
  bonus: z.number().min(0).max(1_000_000).optional().describe('Monthly bonus, gross (0-1,000,000). "no bonus" -> 0.'),
  pensionPct: z.number().min(0).max(100).optional().describe('Employee pension as a plain number between 0 and 100: 6 for "6%" or "6 אחוז".'),
  studyFundPct: z.number().min(0).max(100).optional().describe('Employee study fund as a plain number between 0 and 100: 2.5 for "2.5%".'),
  creditPoints: z.number().min(0).max(50).optional().describe('Tax credit points (0-50), for example 2.75.'),
  childrenUnder23: z.number().int().min(0).max(30).optional().describe('Number of children up to the age limit in the rules (whole number 0-30). "no children" -> 0.'),
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
  alternative: z.string().min(1).max(40).optional().describe('Optional catalogue car id to report about. Reporting only: this tool never opens a question.'),
});

export const MarkUnknownInputSchema = z.object({
  fields: z
    .array(z.enum(UNKNOWABLE_FIELDS))
    .min(1)
    .max(UNKNOWABLE_FIELDS.length)
    .describe('ONLY the profile fields the employee EXPLICITLY said she does not know or does not have.'),
});

export const ProvideReferenceInputSchema = z.object({
  employeeRef: z
    .string()
    .max(500)
    .optional()
    .describe('Exactly what the employee wrote to identify herself (name or employee number). Omit it when she gave none or declined.'),
});

// ---------------------------------------------------------------- helpers

const invalidArguments = (issues: { path: string; code: string }[]): ToolError => ({
  status: 'error',
  error: 'invalid_arguments',
  issues,
});

function toOptionRef(arg: string): OptionRef | null {
  if (arg === 'waiver') return { kind: 'waiver' };
  if (getCatalogCar(arg)) return { kind: 'car', carId: arg };
  // the employee picks by NAME: the server resolves it from the catalogue (never a guess; ambiguous or unknown -> unknown_car)
  const m = matchCatalogCar(arg);
  return m.status === 'found' ? { kind: 'car', carId: m.car.id } : null;
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
  /** Called with the field names of an input that failed the schema (the server counts rejected attempts per field). */
  onInvalid?: (fields: string[]) => Promise<Record<string, unknown>>,
) {
  return tool({
    description,
    inputSchema: input,
    execute: async (raw: unknown) => {
      let result: unknown;
      const parsed = input.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), code: i.code }));
        result = { ...invalidArguments(issues), ...(onInvalid ? await onInvalid(issues.map((i) => i.path.split('.')[0] ?? '')) : {}) };
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

/** Remembers in the turn collector which questions the server opened or queued (ask_representative reports from it). */
function recordEscalations(ctx: ToolContext, reply: EscalationReply): void {
  for (const r of reply.results) ctx.collector.escalations.push({ kind: r.kind, field: r.field, outcome: r.outcome });
}

function escalationOutput(ctx: ToolContext, reply: EscalationReply) {
  recordEscalations(ctx, reply);
  const sent = reply.results.filter((r) => r.outcome === 'question_sent').length;
  return {
    status: 'ok' as const,
    results: reply.results.map((r) => ({ field: r.field, outcome: r.outcome })),
    note: sent > 0 ? 'the question was sent to the representative in this turn' : 'nothing new was sent',
  };
}

// ---------------------------------------------------------------- tools

const MARKERS = new Set(['question_sent', 'waiting', 'needs_reference', 'already_answered', 'cap_reached']);

export function createTools(ctx: ToolContext): ToolSet {
  const { repo, actor } = ctx;

  /** Counts a rejected attempt per field; the marker tells the bot a question went to the representative instead. */
  const countRejected = async (fields: string[]): Promise<Record<string, unknown>> => {
    const reply = await noteRejectedFields(repo, actor, fields.filter((f) => f !== ''));
    recordEscalations(ctx, reply);
    if (reply.results.length > 0) ctx.collector.touchedState = true;
    const outcome = reply.results.map((r) => r.outcome).find((o) => MARKERS.has(o));
    return outcome ? { representative: outcome } : {};
  };

  const save_employee_data = defineTool(
    ctx,
    'save_employee_data',
    'Save EVERY fact the employee stated about themselves in ONE call (send all of them together, any subset). ' +
      'Only numbers the employee actually wrote in this conversation are accepted: if one was not stated, the whole call is ' +
      'rejected (value_not_stated_by_employee) and NOTHING is saved. If you send an occupation without a group, the group is ' +
      'derived from the occupation table and returned as derivedGroup (mention it once as an assumption; do not ask). The current car is resolved by the server, not here. ' +
      'Returns what is still missing for today\'s situation and askNext (the next batch of 2-3 related items to ask about together in one short question).',
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
      // 0. an occupation that is not in the occupations table is rejected like any invalid value (nothing from this call is
      //    saved). The server counts it: the 1st time the employee is asked to pick from the list, the 2nd time the SERVER
      //    asks the representative and the error says so.
      let representative: string | undefined;
      if (a.occupation !== undefined && !getOccupation(a.occupation)) {
        // a spelling the table does not have (gender form, plural, typo): the table row is found by the server, never by the model
        const m = matchOccupation(a.occupation);
        if (m.status === 'found') fields.occupation = m.occupation.name;
        else if (m.status === 'ambiguous') {
          return {
            status: 'error' as const,
            error: 'occupation_ambiguous',
            issues: [{ path: 'occupation', code: 'ambiguous' }],
            options: m.occupations.map((o) => o.name), // never hides an option
          };
        }
      }
      if (a.occupation !== undefined && !getOccupation(String(fields.occupation))) {
        const noted = await noteUnresolved(repo, actor, 'occupation', a.occupation);
        ctx.collector.touchedState = true;
        recordEscalations(ctx, noted);
        const outcome = noted.results[0]?.outcome;
        if (outcome !== undefined && MARKERS.has(outcome)) representative = outcome;
      }

      // 1. ranges and shapes, server side
      const valid = ProfileFieldsSchema.safeParse(fields);
      if (!valid.success) {
        const issues = valid.error.issues.map((i) => ({ path: i.path.map(String).join('.'), code: i.code }));
        return {
          ...invalidArguments(issues),
          ...(representative ? { representative } : await countRejected(issues.map((i) => i.path.split('.')[0] ?? ''))),
        };
      }

      // 2. provenance: the employee must have written every numeric value. One unsupported value rejects the WHOLE call.
      const claimed: Partial<Record<ProvenanceField, number>> = {};
      for (const f of PROVENANCE_FIELDS) if (a[f] !== undefined) claimed[f] = a[f];
      if (Object.keys(claimed).length > 0) {
        if (!ctx.conversationId) return { status: 'error' as const, error: 'provenance_unavailable' };
        const own = (await repo.listMessages(ctx.conversationId, 1000)).filter((m) => m.role === 'user').map((m) => m.content);
        const unsupported = checkProvenance(claimed, own);
        if (unsupported.length > 0) {
          return {
            status: 'error' as const,
            error: 'value_not_stated_by_employee',
            issues: unsupported.map((path) => ({ path, code: 'not_in_employee_messages' })),
            ...(await countRejected(unsupported)),
          };
        }
      }

      // 3. an occupation without a group: the group comes from the occupations table (never from the model)
      let update: ProfileFields = { ...valid.data };
      let derivedGroup: GroupCode | undefined;
      if (update.occupation !== undefined && update.group === undefined) {
        const occupation = getOccupation(update.occupation);
        const existing = await repo.getProfile(actor.userId);
        if (occupation && !existing?.groupCode) {
          derivedGroup = occupation.group;
          update = { ...update, group: occupation.group };
        }
      }

      const state = await updateProfile(repo, actor, update, { currentCarYearAssumed: fields.currentCar !== undefined && (fields.currentCar as { kind: string }).kind === 'car' });
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
        askNext: askBatchLabels(t.missingFields, [...state.questions.filter((q) => q.status === 'open').map((q) => q.field), ...Object.keys(state.profile.fieldGaps)]),
        ...(derivedGroup ? { derivedGroup } : {}),
        ...(t.status === 'ok' && t.today ? { todayNet: t.today.components.net } : {}),
      };
    },
    countRejected,
  );

  const search_catalog = defineTool(
    ctx,
    'search_catalog',
    'List valid occupation names, or ALL the cars this employee may choose (own group and lower groups, plus the waiver verdict). Drive words are final Hebrew: copy them as they are.',
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
      // Built by the same eligibility function check_eligibility uses (see eligibleCars.ts): list and verdict cannot disagree.
      const { profile } = await prepareEmployeeTurn(repo, actor);
      const opts = listAllowedOptions(profile);
      return {
        status: opts.status,
        cars: opts.cars,
        occupations: [],
        waiverAllowed: opts.waiverAllowed ?? undefined,
        missingFields: opts.missingFields,
        missingText: opts.missingText,
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
      return runEligibilityCheck(repo, actor, ref); // shared with the server's own check (src/agent/agent.ts)
    },
  );

  const get_usage_value = defineTool(
    ctx,
    'get_usage_value',
    'Official monthly usage value (שווי שימוש) of a car, from the dataset. Give carId, or maker/model(/registrationYear) to search (Latin names such as "corolla cross" also work with Hebrew names).',
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
      let rows = searchVehicles(index, { maker: a.maker, model: a.model, registrationYear: a.registrationYear }, 8);
      if (rows.length === 0) {
        // Hebrew names: use the same deterministic matcher as everywhere else, then read the dataset rows of that car
        const m = matchCatalogCar(`${a.maker ?? ''} ${a.model ?? ''}`);
        if (m.status === 'found') {
          const car = m.car;
          rows = index.rows
            .filter((r) => r.makerCode === car.makerCode && r.modelCode === car.modelCode && r.registrationYear === (a.registrationYear ?? car.registrationYear))
            .slice(0, 8);
        }
      }
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
      const startedAt = new Date().toISOString();
      const state = await selectAlternative(repo, actor, ref);
      ctx.collector.touchedState = true;
      const raw = state.comparison;
      if (!raw) return { status: 'error' as const, error: 'no_comparison' };
      const view = applyProvisionalPolicy(raw, ctx.showProvisional);
      ctx.collector.lastView = view;
      const pendingQuestion = state.questions.find((q) => q.id === view.pendingQuestionId);
      const representative: 'none' | 'sent' | 'waiting' | 'needs_reference' =
        pendingQuestion !== undefined
          ? pendingQuestion.createdAt >= startedAt
            ? 'sent'
            : 'waiting'
          : 'none';
      const base = {
        representative,
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
    'REPORT-ONLY. Tells you whether the SERVER has already sent a question to the representative (sent / waiting / answered / none_open). It never opens a question: only the server does, when information is truly missing and the employee cannot provide it. Never promise or claim a question that this tool did not report.',
    AskRepInputSchema,
    AskRepOutputSchema,
    async (a) => {
      const { questions } = await listQuestionStatus(repo, actor);
      const about = a.alternative ? questions.filter((q) => q.carId === a.alternative) : questions;
      const sentNow = ctx.collector.escalations.some((e) => e.outcome === 'question_sent');
      // the note is ALWAYS a fixed template for the stored status: the bot never describes the representative's answer
      const waiting = about.filter((q) => q.status === 'open' || q.status === 'clarification' || q.status === 'checking');
      if (waiting.length > 0) {
        const top = waiting.find((q) => q.status === 'clarification') ?? waiting.find((q) => q.status === 'checking') ?? waiting[0]!;
        return { status: sentNow ? ('sent' as const) : ('waiting' as const), note: top.statusText };
      }
      if (about.some((q) => q.status === 'unresolved')) return { status: 'unresolved' as const, note: STATUS_TEXT.unresolved };
      if (about.some((q) => q.status === 'answered')) return { status: 'already_answered' as const, note: STATUS_TEXT.answered };
      return { status: 'none_open' as const, note: STATUS_TEXT.none };
    },
  );

  const mark_field_unknown = defineTool(
    ctx,
    'mark_field_unknown',
    'Report that the employee EXPLICITLY said she does not know or does not have one or more profile fields (pension %, study fund %, credit points, group, base salary, commissions, bonus, children). ' +
      'Ask for the value first; call this ONLY after she said she cannot provide it. This is a structured report: the SERVER decides, and when it opens the question it does so in this same turn (see the result). Never use it for a value she simply has not been asked yet.',
    MarkUnknownInputSchema,
    EscalationOutputSchema,
    async (a) => {
      // A field the employee STATED in any message (a number, or "none" in words) is never "unknown": the server records what she
      // wrote and does not escalate it. (The model may have forgotten to save it, or its save may have been rejected.)
      const own = ctx.conversationId
        ? (await repo.listMessages(ctx.conversationId, 1000)).filter((m) => m.role === 'user').map((m) => m.content)
        : [];
      const already: { field: string; outcome: 'already_known' }[] = [];
      const rest: typeof a.fields = [];
      for (const field of a.fields) {
        const stated = (PROVENANCE_FIELDS as readonly string[]).includes(field) && field !== 'base' ? statedFieldValue(own, field as ProvenanceField) : null;
        if (stated === null) {
          rest.push(field);
          continue;
        }
        await updateProfile(repo, actor, { [field]: stated });
        ctx.collector.touchedState = true;
        already.push({ field, outcome: 'already_known' });
      }
      const reply = rest.length > 0 ? await reportUnknownFields(repo, actor, rest, { onlyWhatWasAsked: true }) : { results: [], needsReference: false };
      ctx.collector.touchedState = true;
      const out = escalationOutput(ctx, reply);
      return { ...out, results: [...already, ...out.results] };
    },
  );

  const provide_employee_reference = defineTool(
    ctx,
    'provide_employee_reference',
    'Call this ONLY when the employee herself volunteered a name or an employee number in her own message. Pass exactly what she wrote (employeeRef). Never ask for it and never wait for it: questions are opened without it. The server attaches it to the open questions as unverified text.',
    ProvideReferenceInputSchema,
    EscalationOutputSchema,
    async (a) => {
      const reply = await provideEmployeeReference(repo, actor, a.employeeRef);
      ctx.collector.touchedState = true;
      return escalationOutput(ctx, reply);
    },
  );

  return { save_employee_data, search_catalog, check_eligibility, get_usage_value, calculate_comparison, ask_representative, mark_field_unknown, provide_employee_reference };
}
