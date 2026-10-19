import { generateText, stepCountIs, type ModelMessage } from 'ai';
import { loadRules } from '../config/rules';
import { matchCatalogCar } from '../data/carMatch';
import type { Repo } from '../db/repo';
import { missingFieldLabel } from '../lib/explain';
import { participationFromRepresentative } from '../lib/flags';
import { prepareEmployeeTurn, type Actor, type TurnContext } from '../lib/service';
import { MAX_ASK, askNextLabels } from './askNext';
import { runEligibilityCheck } from './eligibilityCheck';
import { guardLogCode, guardResponse, type GuardReason } from './guard';
import { buildStateBlock, buildSystemPrompt } from './prompt';
import { withFallback, type FallbackOptions, type ProviderEntry } from './providers';
import { newCollector, createTools, type TurnCollector } from './tools';

const HISTORY_LIMIT = 20;
const MAX_STEPS = 8;
// Per model request 25s (a blocked provider is given up on quickly), and 45s for the whole multi-step call.
const CALL_TIMEOUT = { stepMs: 25_000, totalMs: 45_000 } as const;

export const NEUTRAL_FALLBACK_HE = 'לא הצלחתי לנסח תשובה מדויקת. אפשר לנסח את השאלה מחדש או לספר לי מה חסר לך?';

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
    if (g) return `הנחתי שהקבוצה שלך היא ${g} לפי טבלת העיסוקים.`;
  }
  return '';
}

/** Deterministic Hebrew text built only from tool results (which come from src/lib/explain.ts and the rules engine). */
export function deterministicText(collector: TurnCollector): string {
  const parts: string[] = [];
  // A refusal always wins: it is the one thing the employee must not miss.
  for (const f of ineligibleFacts(collector)) parts.push(`אין זכאות לחלופה "${f.label}".\n${f.reason}.`);
  const view = collector.lastView;
  if (view && view.status !== 'ineligible') {
    // Data missing (no net to show): ask for the next items TOGETHER, at most MAX_ASK, instead of listing everything.
    // A "missing" view that still shows today's net (a representative question is open) keeps its own explanation.
    parts.push(
      view.status === 'missing' && !view.today && view.missingFields.length > 0
        ? `חסר לי מידע כדי להמשיך: ${askNextLabels(view.missingFields).join(', ')}.`
        : view.explanation.join('\n'),
    );
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
          ? `לא שמרתי את הנתונים כי לא מצאתי בהודעות שלך את: ${labels.join(', ')}. אפשר לכתוב לי אותם?`
          : `הערכים הבאים אינם תקינים: ${labels.join(', ')}. אפשר לכתוב אותם שוב?`;
      }
    }
    // What is missing, grouped into ONE short question (at most MAX_ASK items).
    if (o?.missingText && o.missingText.length > 0) {
      const labels = o.missingFields && o.missingFields.length > 0 ? askNextLabels(o.missingFields) : o.missingText.slice(0, MAX_ASK);
      return [derivedGroupSentence(collector), `חסר לי מידע כדי להמשיך: ${labels.join(', ')}.`].filter(Boolean).join('\n');
    }
    if (r.tool === 'check_eligibility' && o?.text) {
      return o.status === 'eligible' && o.alternativeLabel
        ? `אפשר לבחור את "${o.alternativeLabel}": ${o.text}. אם תרצה, אחשב כמה זה ישנה בנטו.`
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

async function history(repo: Repo, conversationId: string): Promise<ModelMessage[]> {
  const all = (await repo.listMessages(conversationId)).slice(-HISTORY_LIMIT);
  const msgs: ModelMessage[] = all.map((m) =>
    m.role === 'user'
      ? { role: 'user', content: m.content }
      : { role: 'assistant', content: m.role === 'system' ? `[הודעת מערכת] ${m.content}` : m.content },
  );
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
      const stateBlock = buildStateBlock(ctx, showProvisional);
      const result = await generateText({
        model: p.model,
        instructions: buildSystemPrompt(stateBlock, fromRep),
        messages: await history(repo, conversationId),
        tools: createTools({ repo, actor, collector, showProvisional, participationFromRepresentative: fromRep, conversationId }),
        stopWhen: stepCountIs(MAX_STEPS),
        maxRetries: 0, // retries and backoff are handled by withFallback
        temperature: 0.2,
        timeout: CALL_TIMEOUT,
      });
      return { text: result.text, collector, ctx, stateBlock, rejectedTools: sdkToolErrors(result.steps) };
    },
    args.fallback,
  );

  const { collector } = value;
  const toolErrors = logToolErrors(collector, value.rejectedTools);
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
    const g = guardResponse(text, collector, [value.stateBlock]);
    if (!g.ok) {
      guardReason = g.reason;
      codes.push(guardLogCode(g));
      assistantText = '';
    }
  }

  if (assistantText === '') {
    // 1. whatever the tools already established (a refusal reason, an explanation, what is missing)
    assistantText = deterministicText(collector);
    via = 'deterministic';
    // 2. nothing from the tools: let the SERVER check the car the employee named, with the same engine and rules
    if (assistantText === NEUTRAL_FALLBACK_HE) {
      try {
        if (await serverEligibility(args, collector)) {
          assistantText = deterministicText(collector);
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

  const ensured = ensureIneligibleReason(assistantText, collector);
  if (ensured.appended) console.info(`[netwise] chat: ineligible reason appended (provider=${provider})`);

  return {
    assistantText: ensured.text,
    collector,
    context: value.ctx,
    provider,
    guardReason,
    logCodes: codes,
    via,
    reasonAppended: ensured.appended,
  };
}
