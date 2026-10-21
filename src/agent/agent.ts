import { generateText, stepCountIs, type ModelMessage } from 'ai';
import { loadRules } from '../config/rules';
import { matchCatalogCar } from '../data/carMatch';
import type { Repo } from '../db/repo';
import { buildTodayOnly } from '../lib/comparison';
import { missingFieldLabel } from '../lib/explain';
import { employeeLabelFor, FIELD_NAME_HE, isRepKind } from '../lib/repQuestions';
import { altNotOnListText, CAR_NOT_FOUND_SENT_TEXT, carNotFoundText, eligibleOptionsText, altNotOnListShortText, CHOOSE_ANOTHER_CAR_TEXT, CHOOSE_CAR_TEXT, pickCarText, pickCurrentCarText, pickOccupationText, repQuestionSentText } from '../lib/repTemplates';
import { participationFromRepresentative } from '../lib/flags';
import { noteRejectedFields, prepareEmployeeTurn, type Actor, type CarIssue, type TurnContext } from '../lib/service';
import { MAX_BATCH, askBatchLabels } from './askNext';
import { runEligibilityCheck } from './eligibilityCheck';
import { closingInviteText, ensureSingleResult, fixWaiverMentions, resultSummaryText, stripCarCodes, stripYearRequests, withRepBridge } from './flowText';
import { claimsRepQuestion, guardLogCode, guardResponse, type GuardReason } from './guard';
import { listAllowedOptions } from './eligibleCars';
import { buildCarChoices } from './carChoices';
import { PAYSLIP_MARKER_TEXT, PAYSLIP_OFFER_TEXT } from '../lib/payslipMarker';
import { answeredAPick, dropCarListLines, dropListedNames, modelNamesOfLabels } from './listDedupe';
import { buildStateBlock, buildSystemPrompt } from './prompt';
import { withFallback, type FallbackOptions, type ProviderEntry } from './providers';
import { newCollector, createTools, SaveInputSchema, type TurnCollector } from './tools';

const HISTORY_LIMIT = 20;
const MAX_STEPS = 8;
// Per model request 25s (a blocked provider is given up on quickly), and 45s for the whole multi-step call.
const CALL_TIMEOUT = { stepMs: 25_000, totalMs: 45_000 } as const;

export const NEUTRAL_FALLBACK_HE = 'לא הצלחתי לענות כמו שצריך. אפשר לנסח את השאלה מחדש או לספר לי מה חסר?';

export interface AgentTurnArgs {
  repo: Repo;
  actor: Actor;
  conversationId: string;
  /** Context prepared at the start of the turn (representative answers already applied). */
  context: TurnContext;
  providers: ProviderEntry[];
  showProvisional: boolean;
  /** PARTICIPATION_FROM_REPRESENTATIVE. Default: read the env flag (false). Selects the prompt policy. */
  participationFromRepresentative?: boolean;
  /** The employee's message of this turn. Used only to let the SERVER resolve a named car when the model gave no usable answer. */
  userMessage?: string;
  /** A server-written instruction appended as the last user turn for the model only. It is never stored or shown. */
  transientInstruction?: string;
  /** Cars the employee named that are not on the company's list, as found by the server at the start of the turn. */
  carIssues?: CarIssue[];
  /** Questions the server opened at the start of the turn (before the model ran). */
  openedAtStart?: { kind: string; field: string }[];
  fallback?: FallbackOptions;
}

/** How the final text was produced when it is not the model's own text. */
export type AnswerVia = 'deterministic' | 'server_eligibility' | 'neutral_fallback';

export interface AgentTurnResult {
  assistantText: string;
  collector: TurnCollector;
  context: TurnContext;
  provider: string;
  /** Set when the model text was not used as is. */
  guardReason?: GuardReason | 'empty';
  /** Short reason codes that were logged (guard:unknown_number, guard:no_tool_result, empty_answer, tool_error ...). */
  logCodes: string[];
  via?: AnswerVia;
  /** True when the engine's Hebrew refusal reason had to be appended to an otherwise acceptable model text. */
  reasonAppended: boolean;
}

interface IneligibleFact {
  label: string;
  reason: string;
}

/** Every "ineligible" verdict of this turn, with the engine's Hebrew reason (from check_eligibility or calculate_comparison). */
export function ineligibleFacts(collector: TurnCollector): IneligibleFact[] {
  const out: IneligibleFact[] = [];
  const seen = new Set<string>();
  for (const r of collector.results) {
    const o = r.output as { status?: string; alternativeLabel?: string; text?: string; eligibilityText?: string } | null;
    if (!o || o.status !== 'ineligible') continue;
    const reason = r.tool === 'check_eligibility' ? o.text : r.tool === 'calculate_comparison' ? o.eligibilityText : undefined;
    if (!reason) continue;
    const key = `${o.alternativeLabel ?? ''}|${reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: o.alternativeLabel ?? '', reason });
  }
  return out;
}

/** One plain sentence stating the group that the server derived from the occupation (an assumption, not a question). */
export function derivedGroupSentence(collector: TurnCollector): string {
  for (const r of collector.results) {
    const g = (r.output as { derivedGroup?: string } | null)?.derivedGroup;
    if (g) return `הנחתי שקבוצת הזכאות היא ${g} לפי טבלת העיסוקים.`;
  }
  return '';
}

/** Deterministic Hebrew text built only from tool results (which come from src/lib/explain.ts and the rules engine). */
export function deterministicText(collector: TurnCollector, opts: { skipCurrentCar?: boolean; skip?: string[] } = {}): string {
  const parts: string[] = [];
  const age0 = loadRules().familyTrack.childMaxAge;
  const carLabelHe = missingFieldLabel('currentCar', age0);
  const without = (labels: string[]) => (opts.skipCurrentCar ? labels.filter((l) => l !== carLabelHe) : labels);
  // A refusal always wins: it is the one thing the employee must not miss.
  for (const f of ineligibleFacts(collector)) parts.push(`אין זכאות לחלופה "${f.label}".\n${f.reason}.`);
  const view = collector.lastView;
  if (view && view.status !== 'ineligible') {
    // Data missing (no net to show): ask for the next items TOGETHER, at most MAX_BATCH, instead of listing everything.
    // A "missing" view that still shows today's net (a representative question is open) keeps its own explanation.
    const askLabels = view.status === 'missing' && !view.today && view.missingFields.length > 0 ? without(askBatchLabels(view.missingFields, opts.skip)) : null;
    if (askLabels === null) parts.push(view.status === 'ok' && view.today && view.alternative ? resultSummaryText(view as Parameters<typeof resultSummaryText>[0]) : view.explanation.join('\n'));
    else if (askLabels.length > 0) parts.push(`כדי להמשיך נצטרך עוד קצת מידע: ${askLabels.join(', ')}.`);
  }
  if (parts.length > 0) return parts.join('\n');

  for (const r of [...collector.results].reverse()) {
    const o = r.output as {
      missingFields?: string[];
      missingText?: string[];
      text?: string;
      status?: string;
      alternativeLabel?: string;
      error?: string;
      issues?: { path: string }[];
    } | null;
    // A rejected value (not written by the employee, or out of range): ask for exactly those fields again.
    if (o?.status === 'error' && o.issues && o.issues.length > 0 && (o.error === 'value_not_stated_by_employee' || o.error === 'invalid_arguments')) {
      const age = loadRules().familyTrack.childMaxAge;
      const labels = [...new Set(o.issues.map((i) => missingFieldLabel(i.path.split('.')[0] ?? '', age)))].filter((l) => l !== 'פרט נוסף');
      if (labels.length > 0) {
        return o.error === 'value_not_stated_by_employee'
          ? `לא מצאתי בהודעות את: ${labels.join(', ')}, ולכן לא שמרתי אותם. אפשר לכתוב אותם כאן?`
          : `נראה שיש בעיה בערכים האלה: ${labels.join(', ')}. אפשר לכתוב אותם שוב?`;
      }
    }
    // What is missing, grouped into ONE short question (at most MAX_BATCH items).
    if (o?.missingText && o.missingText.length > 0) {
      const labels = without(o.missingFields && o.missingFields.length > 0 ? askBatchLabels(o.missingFields, opts.skip) : o.missingText.slice(0, MAX_BATCH));
      if (labels.length === 0) continue;
      return [derivedGroupSentence(collector), `כדי להמשיך נצטרך עוד קצת מידע: ${labels.join(', ')}.`].filter(Boolean).join('\n');
    }
    if (r.tool === 'check_eligibility' && o?.text) {
      return o.status === 'eligible' && o.alternativeLabel
        ? `אפשר לבחור את "${o.alternativeLabel}": ${o.text}. אפשר גם לחשב כמה זה ישנה בנטו.`
        : `${o.text}.`;
    }
  }
  return NEUTRAL_FALLBACK_HE;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * If a tool said "ineligible" this turn, the final answer must carry the engine's Hebrew reason. Model text that already
 * quotes it is left alone; otherwise the reason is appended (never replaced), so nothing the model said is lost.
 */
export function ensureIneligibleReason(text: string, collector: TurnCollector): { text: string; appended: boolean } {
  const facts = ineligibleFacts(collector);
  const flat = squash(text);
  const missing = facts.filter((f) => !flat.includes(squash(f.reason)));
  if (missing.length === 0) return { text, appended: false };
  const lines = missing.map((f) => (facts.length > 1 && f.label ? `"${f.label}": ${f.reason}.` : `${f.reason}.`));
  return { text: [text, ...lines].filter(Boolean).join('\n'), appended: true };
}

/**
 * Cars the employee named that are not on the company's list. The text comes from the SERVER (catalogue labels and the
 * eligibility function, never the model): the current car -> "not found" with same-maker candidates (or, after the 3rd
 * failure, the sentence that a question was sent); an alternative car -> the eligible options for her group. After a refusal
 * (ineligible) the eligible options are appended too. Nothing here opens a question.
 */
export async function ensureCarGuidance(text: string, args: Pick<AgentTurnArgs, 'repo' | 'actor' | 'carIssues'>, collector: TurnCollector): Promise<string> {
  const issues = args.carIssues ?? [];
  const refused = ineligibleFacts(collector).length > 0;
  if (issues.length === 0 && !refused) return text;
  const profile = (await args.repo.getProfile(args.actor.userId)) ?? { userId: args.actor.userId, salaryInputs: {} };
  const opts = listAllowedOptions(profile);
  const optionLines = opts.status === 'ok' ? opts.cars.map((c) => `${c.label}, ${c.drive}`) : [];
  // when the cars to compare are shown as buttons the text never repeats them (one short sentence instead)
  const buttons = (await buildCarChoices(args.repo, args.actor))?.purpose === 'target';
  let out = issues.length > 0 && text === NEUTRAL_FALLBACK_HE ? '' : text; // the bare fallback says nothing the guidance does not
  const add = (extra: string) => {
    if (squash(out).includes(squash(extra))) return;
    out = out === '' ? extra : `${out}\n${extra}`;
  };
  for (const issue of issues) {
    if (issue.pick) {
      // ONE block: what the model wrote about these same cars is dropped, the server list stays
      out = dropListedNames(out, modelNamesOfLabels(issue.candidates));
      add(issue.role === 'current' ? pickCurrentCarText() : pickCarText(issue.candidates, issue.more === true));
    }
    else if (issue.role === 'current') add(issue.opened ? CAR_NOT_FOUND_SENT_TEXT : carNotFoundText(issue.candidates, issue.more === true));
    else add(buttons ? altNotOnListShortText : altNotOnListText(optionLines));
  }
  const alternativeIssue = issues.some((i) => i.role === 'alternative');
  if (refused && !alternativeIssue && optionLines.length > 0) {
    const mentioned = optionLines.filter((l) => out.includes(l.split(',')[0] ?? l)).length;
    if (buttons) add(CHOOSE_ANOTHER_CAR_TEXT);
    else if (mentioned < Math.min(3, optionLines.length)) add(eligibleOptionsText(optionLines, opts.waiverAllowed === true));
  }
  return out;
}

const CURRENT_CAR_WORDS = /היום|כיום|הנוכחי|נוכחי|יש לך|ברכב שלך/u;
const TARGET_CAR_QUESTION =
  /(?:איזה|איזו|באיזה|לאיזה|על איזה)[^.?!\n]{0,40}(?:רכב|חשמלי|דגם)|(?:רכב|חשמלי)[^.?!\n]{0,50}(?:להשוות|לעבור|לשקול)|(?:להשוות|לעבור)[^.?!\n]{0,40}(?:רכב|חשמלי)/u;

/** True when the text asks which car to compare (the car she wants to move to), not about her current car. */
export function asksWhichCarToCompare(text: string): boolean {
  return text.split(/(?<=[.?!])\s+|\n/).some((s) => TARGET_CAR_QUESTION.test(s) && !CURRENT_CAR_WORDS.test(s));
}

/**
 * Whenever the reply asks which car to compare and the server shows the cars as buttons (carChoices, purpose "target": the current car
 * is resolved, today's data is complete, no alternative chosen), whatever list the model wrote is removed and ONE short sentence points
 * to the buttons. The cars are never repeated in the text and never written by the model.
 */
export async function ensureTargetCarOptions(text: string, args: Pick<AgentTurnArgs, 'repo' | 'actor' | 'carIssues'>): Promise<string> {
  if ((args.carIssues ?? []).length > 0) return text;
  const choices = await buildCarChoices(args.repo, args.actor);
  if (!choices || choices.purpose !== 'target') return text;
  const cleaned = dropCarListLines(text, modelNamesOfLabels(choices.cars.map((c) => c.label)));
  if (!asksWhichCarToCompare(cleaned) && !asksWhichCarToCompare(text)) return cleaned;
  if (squash(cleaned).includes(squash(CHOOSE_CAR_TEXT))) return cleaned;
  return cleaned === '' ? CHOOSE_CAR_TEXT : `${cleaned}\n${CHOOSE_CAR_TEXT}`;
}

/**
 * An occupation the employee wrote that fits several rows of the occupations table: the pick-list comes from the table (via the
 * tool result), whatever the model wrote.
 */
export function ensureOccupationGuidance(text: string, collector: TurnCollector): string {
  for (const r of collector.results) {
    const o = r.output as { error?: string; options?: string[] } | null;
    if (o?.error !== 'occupation_ambiguous' || !o.options || o.options.length === 0) continue;
    if (o.options.every((name) => text.includes(name))) continue;
    const sentence = pickOccupationText(o.options);
    text = text === '' || text === NEUTRAL_FALLBACK_HE ? sentence : `${text}
${sentence}`;
  }
  return text;
}

/**
 * After the employee only picked from a pick-list, the reply is ONE short sentence with what is still missing (never the whole list
 * of questions again). null when nothing is missing.
 */
export async function shortMissingSentence(repo: Repo, actor: Actor): Promise<string | null> {
  const { profile, state, openQuestions } = await prepareEmployeeTurn(repo, actor);
  const today = buildTodayOnly({ profile, state });
  if (today.status === 'ok') return null;
  const labels = askBatchLabels(today.missingFields, [...openQuestions.map((q) => q.missingField), ...Object.keys(state.fieldGaps)]);
  return labels.length === 0 ? null : `מעולה, רשמתי. כדי להמשיך חסר לי עוד: ${labels.join(', ')}.`;
}

/**
 * The one-time offer to attach a payslip: appended to the FIRST bot message that asks for pay data, only while no payslip was
 * confirmed and no pay field is saved, and never twice in a conversation.
 */
export async function withPayslipOffer(text: string, repo: Repo, conversationId: string, actor: Actor): Promise<string> {
  if (text.trim() === '' || !text.includes('?')) return text;
  const conv = await repo.getConversation(conversationId);
  if (!conv || (conv.state.payslipFields ?? []).length > 0) return text;
  const profile = (await repo.getProfile(actor.userId)) ?? { userId: actor.userId, salaryInputs: {} };
  if (Object.values(profile.salaryInputs).some((v) => v !== undefined)) return text;
  const sent = await repo.listMessages(conversationId, 500);
  if (sent.some((m) => (m.role === 'assistant' && m.content.includes(PAYSLIP_OFFER_TEXT)) || (m.role === 'system' && m.content === PAYSLIP_MARKER_TEXT))) return text;
  const today = buildTodayOnly({ profile, state: conv.state });
  if (today.status !== 'missing' || !today.missingFields.includes('base')) return text;
  return `${text}
${PAYSLIP_OFFER_TEXT}`;
}

/** Labels of the representative questions the SERVER opened in this turn (before the model ran, or through a tool). */
function questionsOpenedThisTurn(collector: TurnCollector, atStart: { kind: string; field: string }[]): string[] {
  const labels: string[] = [];
  const add = (l: string) => {
    if (!labels.includes(l)) labels.push(l);
  };
  for (const s of atStart) add(isRepKind(s.kind) ? employeeLabelFor(s.kind, s.field) : FIELD_NAME_HE.overBudgetPolicy);
  for (const e of collector.escalations) if (e.outcome === 'question_sent') add(isRepKind(e.kind) ? employeeLabelFor(e.kind, e.field) : 'נתון נוסף');
  for (const r of collector.results) {
    const o = r.output as { status?: string; representative?: string; issues?: { path: string }[] } | null;
    if (!o) continue;
    if (r.tool === 'calculate_comparison' && o.representative === 'sent') {
      add(collector.lastView?.missingFields.includes('overBudgetPolicy') ? FIELD_NAME_HE.overBudgetPolicy : FIELD_NAME_HE.alternativeParticipation);
    }
    if (r.tool === 'save_employee_data' && o.status === 'error' && o.representative === 'question_sent') {
      const field = o.issues?.[0]?.path.split('.')[0] ?? '';
      add(field === 'occupation' ? FIELD_NAME_HE.occupation : (FIELD_NAME_HE as Record<string, string>)[field] ?? 'נתון');
    }
  }
  return labels;
}

/**
 * Whenever the server opened a representative question in this turn, the final text says so - also after a guard replacement
 * and in every deterministic fallback. A text that already says it (any wording the guard recognises) is left alone.
 */
export function ensureQuestionSentence(text: string, collector: TurnCollector, atStart: { kind: string; field: string }[]): string {
  const labels = questionsOpenedThisTurn(collector, atStart);
  if (labels.length === 0 || claimsRepQuestion(text)) return text;
  const sentence = repQuestionSentText(labels);
  return text === '' || text === NEUTRAL_FALLBACK_HE ? sentence : `${text}\n${sentence}`;
}

async function history(repo: Repo, conversationId: string, transient?: string): Promise<ModelMessage[]> {
  const all = (await repo.listMessages(conversationId)).slice(-HISTORY_LIMIT);
  const msgs: ModelMessage[] = all.map((m) =>
    m.role === 'user'
      ? { role: 'user', content: m.content }
      : { role: 'assistant', content: m.role === 'system' ? `[הודעת מערכת] ${m.content}` : m.content },
  );
  if (transient) msgs.push({ role: 'user', content: transient });
  while (msgs[0] && msgs[0].role !== 'user') msgs.shift();
  return msgs;
}

/**
 * The model gave nothing usable and no tool left a deterministic answer. If the employee's message names ONE catalogue car,
 * the server runs the same eligibility check the tool would have run and records it like a tool result.
 */
async function serverEligibility(args: AgentTurnArgs, collector: TurnCollector): Promise<boolean> {
  if (!args.userMessage) return false;
  const match = matchCatalogCar(args.userMessage);
  if (match.status !== 'found') return false;
  const output = await runEligibilityCheck(args.repo, args.actor, { kind: 'car', carId: match.car.id });
  collector.results.push({ tool: 'check_eligibility', output });
  return true;
}

/**
 * Logs every failed tool call of the turn by tool name and error code only. Two kinds exist: errors our tool returned
 * (unknown car...) and calls the AI SDK rejected before our tool ran (arguments that fail the input schema).
 */
function logToolErrors(collector: TurnCollector, sdkRejected: string[]): number {
  let n = 0;
  for (const r of collector.results) {
    const o = r.output as { status?: string; error?: string } | null;
    if (o?.status !== 'error') continue;
    n++;
    console.warn(`[netwise] chat: tool_error (tool=${r.tool}, error=${o.error ?? 'unknown'})`);
  }
  for (const tool of sdkRejected) {
    n++;
    console.warn(`[netwise] chat: tool_error (tool=${tool}, error=invalid_tool_call)`);
  }
  return n;
}

/** Names of tools whose call the AI SDK turned into a tool-error part (e.g. input failed the schema, unknown tool name). */
function sdkToolErrors(steps: readonly { content: readonly { type: string; toolName?: string }[] }[]): string[] {
  return steps.flatMap((s) => s.content.filter((p) => p.type === 'tool-error').map((p) => p.toolName ?? 'unknown'));
}

/**
 * save_employee_data calls that the AI SDK rejected BEFORE the tool ran (a value outside the schema's range): the fields that
 * failed. The server counts these like any other rejected attempt (3 rejections of one field -> one representative question).
 */
function sdkRejectedSaveFields(steps: readonly { content: readonly { type: string; toolName?: string; input?: unknown }[] }[]): string[] {
  const out: string[] = [];
  for (const s of steps) {
    for (const p of s.content) {
      if (p.type !== 'tool-error' || p.toolName !== 'save_employee_data') continue;
      const parsed = SaveInputSchema.safeParse(p.input);
      if (!parsed.success) out.push(...parsed.error.issues.map((i) => String(i.path[0] ?? '')));
    }
  }
  return out.filter((f) => f !== '');
}

/** One employee turn: model + tools with provider fallback, then the response guard. Throws AllProvidersFailedError. */
export async function runAgentTurn(args: AgentTurnArgs): Promise<AgentTurnResult> {
  const { repo, actor, conversationId, providers, showProvisional } = args;
  const fromRep = args.participationFromRepresentative ?? participationFromRepresentative();
  let first = true;

  const { value, provider } = await withFallback(
    providers,
    async (p) => {
      // A retry starts from freshly saved state (an earlier attempt may already have saved data).
      const ctx: TurnContext = first
        ? args.context
        : { ...(await prepareEmployeeTurn(repo, actor)), updates: args.context.updates };
      first = false;
      const collector = newCollector();
      const stateBlock = buildStateBlock(ctx, showProvisional, args.carIssues);
      const result = await generateText({
        model: p.model,
        instructions: buildSystemPrompt(stateBlock, fromRep),
        messages: await history(repo, conversationId, args.transientInstruction),
        tools: createTools({ repo, actor, collector, showProvisional, participationFromRepresentative: fromRep, conversationId }),
        stopWhen: stepCountIs(MAX_STEPS),
        maxRetries: 0, // retries and backoff are handled by withFallback
        temperature: 0.2,
        timeout: CALL_TIMEOUT,
      });
      return { text: result.text, collector, ctx, stateBlock, rejectedTools: sdkToolErrors(result.steps), rejectedFields: sdkRejectedSaveFields(result.steps) };
    },
    args.fallback,
  );

  const { collector } = value;
  const toolErrors = logToolErrors(collector, value.rejectedTools);
  if (value.rejectedFields.length > 0) {
    try {
      // a question the server opens because of these rejections is reported like any other (the final text must say so)
      const noted = await noteRejectedFields(repo, actor, value.rejectedFields);
      for (const r of noted.results) collector.escalations.push({ kind: r.kind, field: r.field, outcome: r.outcome });
    } catch (err) {
      console.error(`[netwise] chat: counting rejected values failed (${err instanceof Error ? err.name : 'unknown'})`);
    }
  }
  const codes: string[] = [];
  const text = value.text.trim();
  let assistantText = text;
  let guardReason: AgentTurnResult['guardReason'];
  let via: AnswerVia | undefined;

  if (text === '') {
    guardReason = 'empty';
    codes.push('empty_answer');
    assistantText = '';
  } else {
    // digits the employee wrote about a car that was not found ("3000" in a model name) may be quoted back to her
    const g = guardResponse(text, collector, [value.stateBlock, ...(args.carIssues ?? []).map((i) => i.text)], { repOpen: value.ctx.openQuestions.length > 0 });
    if (!g.ok) {
      guardReason = g.reason;
      codes.push(guardLogCode(g));
      assistantText = '';
    }
  }

  if (assistantText === '') {
    // 1. whatever the tools already established (a refusal reason, an explanation, what is missing)
    const skipCar = (args.carIssues ?? []).some((i) => i.role === 'current');
    const skip = [...value.ctx.openQuestions.map((q) => q.missingField), ...Object.keys(value.ctx.state.fieldGaps), ...(value.ctx.state.payslipFields ?? [])];
    assistantText = deterministicText(collector, { skipCurrentCar: skipCar, skip });
    via = 'deterministic';
    // 2. nothing from the tools: let the SERVER check the car the employee named, with the same engine and rules
    if (assistantText === NEUTRAL_FALLBACK_HE) {
      try {
        if (await serverEligibility(args, collector)) {
          assistantText = deterministicText(collector, { skipCurrentCar: skipCar, skip });
          via = 'server_eligibility';
        }
      } catch (err) {
        console.error(`[netwise] chat: server eligibility check failed (${err instanceof Error ? err.name : 'unknown'})`);
      }
    }
    // 3. truly nothing deterministic to say
    if (assistantText === NEUTRAL_FALLBACK_HE) {
      via = 'neutral_fallback';
      if (toolErrors > 0) codes.push('tool_error');
    }
    console.warn(`[netwise] chat: answer replaced (reason=${codes.join('+')}, via=${via}, provider=${provider})`);
  }

  // the result appears once: a short sentence here, the full breakdown only in the comparison panel
  const single = ensureSingleResult(assistantText, collector);
  if (single !== assistantText) console.info(`[netwise] chat: result bubble shortened (provider=${provider})`);
  assistantText = single;

  const ensured = ensureIneligibleReason(assistantText, collector);
  if (ensured.appended) console.info(`[netwise] chat: ineligible reason appended (provider=${provider})`);
  const guided = await ensureCarGuidance(ensured.text, args, collector);
  const withOptions = await ensureTargetCarOptions(ensureOccupationGuidance(guided, collector), args);
  let finalText = ensureQuestionSentence(withOptions, collector, args.openedAtStart ?? []);
  // she only picked from a list the server showed: nothing to repeat, just what is still missing, in one short sentence
  const quiet = (args.carIssues ?? []).length === 0 && collector.lastView === undefined && ineligibleFacts(collector).length === 0 && collector.escalations.length === 0 && (args.openedAtStart ?? []).length === 0;
  if (quiet && args.userMessage && (await answeredAPick(repo, conversationId, args.userMessage))) {
    const short = await shortMissingSentence(repo, actor);
    if (short) finalText = short;
  }
  if (finalText !== ensured.text) console.info(`[netwise] chat: server text appended (provider=${provider})`);
  // internal ids never reach the employee; the waiver is mentioned only when the occupation allows it (and never as a "refund")
  const profileNow = await repo.getProfile(actor.userId);
  const waiverOk = profileNow ? listAllowedOptions(profileNow).waiverAllowed === true : false;
  finalText = fixWaiverMentions(stripYearRequests(stripCarCodes(finalText)), waiverOk);
  // ONE closing sentence, only right after a new comparison
  const newView = collector.lastView;
  if (newView?.status === 'ok' && newView.today && newView.alternative) finalText = `${finalText}\n${closingInviteText(waiverOk)}`;
  finalText = await withPayslipOffer(finalText, repo, conversationId, actor);
  finalText = await withRepBridge(finalText, repo, conversationId);

  return {
    assistantText: finalText,
    collector,
    context: value.ctx,
    provider,
    guardReason,
    logCodes: codes,
    via,
    reasonAppended: ensured.appended,
  };
}
