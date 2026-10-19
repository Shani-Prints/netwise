import type { Repo } from '../db/repo';
import type { Conversation, ProfileRecord, RepQuestion, RepQuestionContext, RepWorkflow } from '../db/types';
import { isSuperseded, requireRep, ServiceError, toRepQuestionView, withLock, type Actor, type RepQuestionView } from './service';
import {
  allowedOutcomes,
  answerSpecFor,
  kindOf,
  labelForCase,
  parseTypedAnswer,
  sanitizeRepText,
  ZERO_OK_FIELDS,
  type AnswerSpec,
  type Outcome,
  type RepKind,
} from './repQuestions';
import { valueIsInText } from './repNumbers';
import {
  clarificationRequestedText,
  EMPLOYEE_NOT_FOUND_TEXT,
  followUpQuestionText,
  MAX_FOLLOW_UPS,
  MAX_INTERPRET_ATTEMPTS,
  overBudgetApprovedText,
  overBudgetDeniedText,
  REFER_ELSEWHERE_TEXT,
  unresolvedFinalText,
  valueUnavailableText,
  WILL_CHECK_LATER_TEXT,
} from './repTemplates';

/**
 * A representative answers in FREE TEXT. The text is DATA: it is stored with the question, interpreted by one isolated model
 * call (src/agent/interpretRepText.ts) and the proposal is then checked by the server with the same validators as the typed
 * API. The employee only ever sees fixed templates or the engine's result; the text itself never leaves this file's storage
 * (the representative's own view of the question) and never reaches an employee-facing prompt or message.
 */

export const MAX_REP_TEXT = 500;
const LEASE_MS = 30_000;
const MAX_QUESTIONS_PER_CALL = 8;

// ------------------------------------------------------------------------------------------------ interpreter contract

/** One open question the text may answer. `alias` (Q1, Q2 ...) is the only id the model may use for a field. */
export interface InterpretQuestion {
  alias: string;
  kind: RepKind;
  field: string;
  spec: AnswerSpec;
  outcomes: readonly Outcome[];
  /** True when "none / zero" is a valid value for this field. */
  zeroOk: boolean;
}
export interface InterpretInput {
  text: string;
  questions: InterpretQuestion[];
}
export type ParsedInterpretation =
  | { result: 'values'; values: { field: string; value: string }[] }
  | { result: 'outcome'; outcome: Outcome }
  | { result: 'not_understood' };
export type InterpretResult =
  | { status: 'ok'; parsed: ParsedInterpretation }
  /** Unusable model answer or timeout: counts as an attempt (max 3, then it is treated as "not understood"). */
  | { status: 'invalid' }
  /** Network, quota or block: nothing is counted; it is retried on the next employee turn / representative screen load. */
  | { status: 'unavailable' };
export type Interpreter = (input: InterpretInput) => Promise<InterpretResult>;

export interface TextDeps {
  interpret: Interpreter;
  now?: () => number;
}

export type Disposition = 'applied' | 'closed' | 'clarification_requested' | 'will_check_later' | 'superseded' | 'unresolved' | 'pending';
export interface SubmitReply {
  question: RepQuestionView;
  /** Where the answer stands. The representative never sees anything the employee sees. */
  interpretation: Disposition;
}

const iso = (ms: number) => new Date(ms).toISOString();
const nowOf = (deps: TextDeps) => (deps.now ?? Date.now)();

/** One log line per interpretation: a reason code and the question kind only. Never the text, never employee data. */
function logResult(kind: RepKind, code: string): void {
  console.info(`[netwise] rep text: ${code} (kind=${kind})`);
}

/** Hebrew name of what a question is about, for the fixed employee messages (a label the SERVER knows). */
function questionLabel(q: RepQuestion): string {
  return labelForCase(kindOf(q), q.missingField);
}

const toInterpretQuestion = (q: RepQuestion, alias: string): InterpretQuestion => {
  const kind = kindOf(q);
  return { alias, kind, field: q.missingField, spec: answerSpecFor(kind, q.missingField), outcomes: allowedOutcomes(kind), zeroOk: ZERO_OK_FIELDS.has(q.missingField) };
};

// ------------------------------------------------------------------------------------------------ phase 1: store the text

/**
 * POST /api/rep/answer-text. Stores the text with the question, then interprets it. A second submission is 409, except while
 * the question is in the non-final state will_check_later.
 */
export async function submitRepText(
  repo: Repo,
  actor: Actor,
  input: { questionId: string; text: string },
  deps: TextDeps,
): Promise<SubmitReply> {
  requireRep(actor);
  const text = sanitizeRepText(input.text);
  if (text === '') throw new ServiceError(400, 'empty_text');
  if (input.text.length > MAX_REP_TEXT) throw new ServiceError(400, 'text_too_long');
  const first = await repo.getRepQuestion(input.questionId);
  if (!first) throw new ServiceError(404, 'question_not_found');
  const conv = await repo.getConversation(first.conversationId);
  if (!conv) throw new ServiceError(404, 'question_not_found');

  await withLock(conv.userId, async () => {
    const q = await repo.getRepQuestion(input.questionId);
    if (!q) throw new ServiceError(404, 'question_not_found');
    if (q.status !== 'open') throw new ServiceError(409, 'already_answered');
    const wf = q.context.workflow;
    if (wf && wf.state !== 'awaiting' && wf.state !== 'will_check_later') throw new ServiceError(409, 'answer_in_progress');
    const now = nowOf(deps);
    await setWorkflow(repo, q, {
      state: 'interpretation_pending',
      text,
      answeredBy: actor.userId,
      submittedAt: iso(now),
      attempts: 0,
      leaseUntil: iso(now + LEASE_MS),
      ...(wf?.rootId ? { rootId: wf.rootId } : {}),
    });
  });

  const interpretation = await interpretAndFinalize(repo, input.questionId, deps);
  const after = await repo.getRepQuestion(input.questionId);
  return { question: toRepQuestionView(after ?? first), interpretation };
}

async function setWorkflow(repo: Repo, q: RepQuestion, workflow: RepWorkflow): Promise<RepQuestion> {
  const context: RepQuestionContext = { ...q.context, workflow };
  return (await repo.updateRepQuestionContext(q.id, context)) ?? { ...q, context };
}

// ------------------------------------------------------------------------------------------------ phase 2: the model

async function interpretAndFinalize(repo: Repo, questionId: string, deps: TextDeps): Promise<Disposition> {
  const q = await repo.getRepQuestion(questionId);
  const wf = q?.context.workflow;
  if (!q || q.status !== 'open' || wf?.state !== 'interpretation_pending' || !wf.text) return 'pending';
  const conv = await repo.getConversation(q.conversationId);
  if (!conv) return 'pending';
  // The text may answer several of this conversation's open questions (row 14): the model sees only their kinds and specs.
  const others = (await repo.listRepQuestions({ conversationId: q.conversationId, status: 'open' }))
    .filter((o) => o.id !== q.id && (!o.context.workflow || o.context.workflow.state === 'awaiting' || o.context.workflow.state === 'will_check_later'))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, MAX_QUESTIONS_PER_CALL - 1);
  const asked = [q, ...others];
  const questions = asked.map((x, i) => toInterpretQuestion(x, `Q${i + 1}`));
  let result: InterpretResult;
  try {
    result = await deps.interpret({ text: wf.text, questions });
  } catch {
    result = { status: 'unavailable' }; // an interpreter never makes the endpoint or the chat fail
  }
  return withLock(conv.userId, () => finalize(repo, conv, q.id, wf.submittedAt, asked.map((x) => x.id), questions, result, wf.text!, deps));
}

// ------------------------------------------------------------------------------------------------ phase 3: decide

/** Validates one proposed value exactly like the typed API, plus: the number must be in the text, zero only where valid. */
function validateValue(q: InterpretQuestion, raw: string, text: string): string | null {
  const canonical = parseTypedAnswer(q.spec, raw);
  if (canonical === null) return null;
  if (q.spec.type !== 'number') return canonical; // an id from the fixed lists: parseTypedAnswer already checked it
  const n = Number(canonical);
  if (n === 0 && !q.zeroOk) return null; // "none" is not a value for base salary, group, occupation or a car
  if (!valueIsInText(text, n)) return null; // the number must literally be in the text (or a clear none / zero phrase)
  if (q.spec.unit === 'percent' && n > 0 && n < 1) return null; // 0.06 or 6 percent? ambiguous
  return canonical;
}

interface Decision {
  /** question index -> canonical value, for every question the text answers validly */
  values: Map<number, string>;
  outcome?: Outcome;
}

function decide(parsed: ParsedInterpretation, questions: InterpretQuestion[], text: string): Decision {
  const none: Decision = { values: new Map() };
  if (parsed.result === 'not_understood') return none;
  if (parsed.result === 'outcome') {
    const first = questions[0]!;
    return first.outcomes.includes(parsed.outcome) && parsed.outcome !== 'other' ? { values: new Map(), outcome: parsed.outcome } : none;
  }
  const byAlias = new Map<string, string[]>();
  for (const v of parsed.values) {
    if (!questions.some((q) => q.alias === v.field)) return none; // an id outside the list: the whole answer is not understood
    byAlias.set(v.field, [...(byAlias.get(v.field) ?? []), v.value.trim()]);
  }
  const values = new Map<number, string>();
  questions.forEach((q, i) => {
    const proposed = byAlias.get(q.alias);
    if (!proposed) return;
    if (new Set(proposed).size > 1) return; // two different values for one field: conflicting
    const ok = validateValue(q, proposed[0]!, text);
    if (ok !== null) values.set(i, ok);
  });
  return { values };
}

async function addSystem(repo: Repo, conversationId: string, text: string): Promise<void> {
  await repo.addMessage(conversationId, 'system', text);
}

async function finalize(
  repo: Repo,
  conv0: Conversation,
  questionId: string,
  submittedAt: string | undefined,
  askedIds: string[],
  questions: InterpretQuestion[],
  result: InterpretResult,
  text: string,
  deps: TextDeps,
): Promise<Disposition> {
  const q = await repo.getRepQuestion(questionId);
  const wf = q?.context.workflow;
  // stale: another worker finished it, or the representative submitted again meanwhile
  if (!q || q.status !== 'open' || wf?.state !== 'interpretation_pending' || wf.submittedAt !== submittedAt) return 'pending';
  const kind = kindOf(q);
  const conv = (await repo.getConversation(conv0.id)) ?? conv0;

  // rows 11 / 12: nothing is lost, nothing is shown to the employee
  if (result.status === 'unavailable') {
    await setWorkflow(repo, q, { ...wf, leaseUntil: undefined });
    logResult(kind, 'pending');
    return 'pending';
  }
  let parsed: ParsedInterpretation = { result: 'not_understood' };
  if (result.status === 'invalid') {
    const attempts = wf.attempts + 1;
    if (attempts < MAX_INTERPRET_ATTEMPTS) {
      await setWorkflow(repo, q, { ...wf, attempts, leaseUntil: undefined });
      logResult(kind, 'pending');
      return 'pending';
    }
  } else {
    parsed = result.parsed;
  }

  const decision = decide(parsed, questions, text);
  const profile: ProfileRecord = (await repo.getProfile(conv.userId)) ?? { userId: conv.userId, salaryInputs: {} };
  const stamp = { answeredBy: wf.answeredBy, submittedAt: wf.submittedAt, text, attempts: wf.attempts, ...(wf.rootId ? { rootId: wf.rootId } : {}) };
  let originalResolved: Disposition | null = null;

  // rows 1, 10, 14: every valid value goes to ITS OWN open question
  for (const [index, canonical] of decision.values) {
    const target = (await repo.getRepQuestion(askedIds[index]!)) ?? null;
    if (!target || target.status !== 'open') continue;
    const targetKind = kindOf(target);
    const latest = (await repo.getConversation(conv.id)) ?? conv;
    if (isSuperseded(target, profile, latest.state)) {
      // row 10: the employee provided it herself: recorded, not applied, not announced
      await setWorkflow(repo, target, { ...stamp, state: 'superseded', result: 'superseded', recordedValue: canonical, rootId: target.context.workflow?.rootId });
      await repo.answerRepQuestion(target.id, 'closed:superseded');
      logResult(targetKind, 'superseded');
      if (index === 0) originalResolved = 'superseded';
      continue;
    }
    await setWorkflow(repo, target, { ...stamp, state: 'closed', result: 'values_applied', rootId: target.context.workflow?.rootId });
    // The value is applied by the normal path (repApply.ts) the next time the employee's screen / chat loads.
    await repo.answerRepQuestion(target.id, canonical);
    logResult(targetKind, 'values_applied');
    if (index === 0) originalResolved = 'applied';
  }
  if (originalResolved) return originalResolved;

  // rows 3 - 7: an outcome without a value
  if (decision.outcome) {
    const latest = (await repo.getConversation(conv.id)) ?? conv;
    const outcome = decision.outcome;
    if (outcome === 'will_check_later') {
      // row 5: not an answer. The question stays open and may be answered again.
      await setWorkflow(repo, q, { ...stamp, state: 'will_check_later', result: 'outcome_will_check_later' });
      await addSystem(repo, conv.id, WILL_CHECK_LATER_TEXT);
      logResult(kind, 'outcome_will_check_later');
      return 'will_check_later';
    }
    if (isSuperseded(q, profile, latest.state)) {
      await setWorkflow(repo, q, { ...stamp, state: 'superseded', result: 'superseded' });
      await repo.answerRepQuestion(q.id, 'closed:superseded');
      logResult(kind, 'superseded');
      return 'superseded';
    }
    const label = questionLabel(q);
    const gap = (type: 'unavailable' | 'not_found' | 'referred') =>
      repo.saveConversationState(conv.id, { ...latest.state, fieldGaps: { ...latest.state.fieldGaps, [q.missingField]: type } });
    let message: string | null = null;
    if (outcome === 'employee_not_found') {
      await gap('not_found');
      message = EMPLOYEE_NOT_FOUND_TEXT;
    } else if (outcome === 'value_unavailable') {
      await gap('unavailable');
      message = valueUnavailableText(label);
    } else if (outcome === 'refer_elsewhere') {
      await gap('referred');
      message = REFER_ELSEWHERE_TEXT;
    } else if (outcome === 'approved') {
      message = overBudgetApprovedText(q.context.carLabel ?? '');
    } else if (outcome === 'denied') {
      message = overBudgetDeniedText(q.context.carLabel ?? '');
    }
    await setWorkflow(repo, q, { ...stamp, state: 'closed', result: `outcome_${outcome}` });
    await repo.answerRepQuestion(q.id, `closed:${outcome}`);
    if (message) await addSystem(repo, conv.id, message);
    logResult(kind, `outcome_${outcome}`);
    return 'closed';
  }

  // rows 8 / 9: not understood, conflicting, not asked about, ambiguous or invalid
  return requestClarification(repo, conv, q, stamp, deps);
}

async function requestClarification(
  repo: Repo,
  conv: Conversation,
  q: RepQuestion,
  stamp: { answeredBy?: string; submittedAt?: string; text: string; attempts: number; rootId?: string },
  _deps: TextDeps,
): Promise<Disposition> {
  const kind = kindOf(q);
  const rootId = q.context.workflow?.rootId ?? q.id;
  const all = await repo.listRepQuestions({ conversationId: conv.id });
  const followUps = all.filter((x) => x.context.workflow?.rootId === rootId).length;
  const label = questionLabel(q);
  if (followUps < MAX_FOLLOW_UPS) {
    // row 8: ONE follow-up from a fixed template that quotes the question (never the old answer), one fixed message
    const root = all.find((x) => x.id === rootId) ?? q;
    await setWorkflow(repo, q, { ...stamp, state: 'clarification_requested', result: 'not_understood' });
    await repo.answerRepQuestion(q.id, 'closed:clarification');
    const { workflow: _drop, ...context } = q.context;
    void _drop;
    await repo.createRepQuestion({
      conversationId: conv.id,
      missingField: q.missingField,
      questionText: followUpQuestionText(root.questionText),
      context: { ...context, workflow: { state: 'awaiting', attempts: 0, rootId } },
    });
    await addSystem(repo, conv.id, clarificationRequestedText(label));
    logResult(kind, 'not_understood');
    return 'clarification_requested';
  }
  // row 9: the cap is reached: unresolved, no further escalation for this case, one final message
  await setWorkflow(repo, q, { ...stamp, state: 'unresolved', result: 'not_understood' });
  await repo.answerRepQuestion(q.id, 'closed:unresolved');
  const latest = (await repo.getConversation(conv.id)) ?? conv;
  await repo.saveConversationState(conv.id, { ...latest.state, fieldGaps: { ...latest.state.fieldGaps, [q.missingField]: 'unresolved' } });
  await addSystem(repo, conv.id, unresolvedFinalText(label));
  logResult(kind, 'not_understood');
  return 'unresolved';
}

// ------------------------------------------------------------------------------------------------ rows 11 / 12: retries

/**
 * Interprets the answers that are still waiting (the model was unavailable, or its answer was unusable). Called at the start
 * of an employee turn (that employee's conversation only) and on a representative screen load (all conversations).
 * Each pending answer is owned by one worker at a time (a lease), so a retry never runs next to the original attempt.
 */
export async function retryPendingInterpretations(
  repo: Repo,
  deps: TextDeps,
  opts: { conversationId?: string; limit?: number } = {},
): Promise<number> {
  const open = await repo.listRepQuestions({ status: 'open', ...(opts.conversationId ? { conversationId: opts.conversationId } : {}) });
  const now = nowOf(deps);
  const due = open
    .filter((q) => {
      const wf = q.context.workflow;
      return wf?.state === 'interpretation_pending' && (!wf.leaseUntil || Date.parse(wf.leaseUntil) <= now);
    })
    .slice(0, opts.limit ?? 5);
  let done = 0;
  for (const candidate of due) {
    const conv = await repo.getConversation(candidate.conversationId);
    if (!conv) continue;
    const claimed = await withLock(conv.userId, async () => {
      const q = await repo.getRepQuestion(candidate.id);
      const wf = q?.context.workflow;
      if (!q || q.status !== 'open' || wf?.state !== 'interpretation_pending') return false;
      if (wf.leaseUntil && Date.parse(wf.leaseUntil) > now) return false;
      await setWorkflow(repo, q, { ...wf, leaseUntil: iso(now + LEASE_MS) });
      return true;
    });
    if (!claimed) continue;
    await interpretAndFinalize(repo, candidate.id, deps);
    done++;
  }
  return done;
}
