import type { Repo } from '../db/repo';
import { participationFromRepresentative } from './flags';
import type { ConversationState, EscalationSpec, RepQuestion } from '../db/types';
import {
  buildContext,
  caseKey,
  caseKeyOf,
  isRepKind,
  MAX_OPEN_QUESTIONS,
  questionText,
  type RepKind,
} from './repQuestions';

/**
 * The ONLY place that decides to open a representative question. It is called by SERVER code (the comparison, the turn
 * triggers, the tool results that carry a structured "unknown" marker) and never because a model or an employee asked.
 *
 *  - once per case: a case that already has a question (open OR answered) is never opened again;
 *  - at most MAX_OPEN_QUESTIONS open at the same time in one conversation;
 *  - the first time ever, the employee is asked (once) for an optional reference; the questions wait in
 *    state.escalation.pending until that prompt has been answered or skipped, then they are all opened.
 */

export type EscalationOutcome = 'question_sent' | 'waiting' | 'already_answered' | 'needs_reference' | 'cap_reached' | 'not_needed';

export interface EscalationResult {
  kind: string;
  field: string;
  carId?: string;
  outcome: EscalationOutcome;
}

export const specKey = (s: Pick<EscalationSpec, 'kind' | 'field' | 'carId'>): string => caseKey(s.kind, s.field, s.carId);

/** Creates the question now. Context comes from the whitelist, text from the template. */
export async function openQuestionNow(
  repo: Repo,
  conversationId: string,
  spec: EscalationSpec,
  employeeRef: string | undefined,
): Promise<RepQuestion> {
  if (!isRepKind(spec.kind)) throw new Error('unknown question kind');
  const kind: RepKind = spec.kind;
  const context = buildContext(kind, { ...spec.source, ...(spec.carId ? { carId: spec.carId } : {}), employeeRef });
  return repo.createRepQuestion({
    conversationId,
    missingField: spec.field,
    questionText: questionText(kind, spec.field, context),
    context,
  });
}

/**
 * Opens (or queues) the questions for these cases. Returns the new conversation state (the caller saves it) and one
 * outcome per case. Never throws for "already there": it reports it.
 */
export async function requestEscalations(
  repo: Repo,
  conversationId: string,
  state: ConversationState,
  specs: EscalationSpec[],
): Promise<{ state: ConversationState; results: EscalationResult[] }> {
  const next: ConversationState = structuredClone(state);
  const esc = next.escalation;
  const existing = await repo.listRepQuestions({ conversationId });
  const byKey = new Map(existing.map((q) => [caseKeyOf(q), q]));
  let open = existing.filter((q) => q.status === 'open').length;
  const canOpen = esc.refAsked; // decided BEFORE this call, so the prompt for the reference comes first
  const results: EscalationResult[] = [];
  let queued = false;

  for (const spec of specs) {
    const base = { kind: spec.kind, field: spec.field, ...(spec.carId ? { carId: spec.carId } : {}) };
    if (spec.kind === 'new_car_participation' && !participationFromRepresentative()) {
      // the participation of the new car is the catalogue default unless PARTICIPATION_FROM_REPRESENTATIVE=true
      results.push({ ...base, outcome: 'not_needed' });
      continue;
    }
    const q = byKey.get(specKey(spec));
    if (q) {
      results.push({ ...base, outcome: q.status === 'open' ? 'waiting' : 'already_answered' });
      continue;
    }
    if (esc.pending.some((p) => specKey(p) === specKey(spec))) {
      results.push({ ...base, outcome: 'needs_reference' });
      continue;
    }
    if (open + esc.pending.length >= MAX_OPEN_QUESTIONS) {
      results.push({ ...base, outcome: 'cap_reached' });
      continue;
    }
    if (!canOpen) {
      esc.pending.push(spec);
      queued = true;
      results.push({ ...base, outcome: 'needs_reference' });
      continue;
    }
    const created = await openQuestionNow(repo, conversationId, spec, esc.employeeRef);
    byKey.set(caseKeyOf(created), created);
    open++;
    results.push({ ...base, outcome: 'question_sent' });
  }
  if (queued) esc.refAsked = true;
  return { state: next, results };
}

/** The reference prompt is over (answered or skipped): open everything that was waiting for it. */
export async function flushPendingEscalations(
  repo: Repo,
  conversationId: string,
  state: ConversationState,
): Promise<{ state: ConversationState; results: EscalationResult[] }> {
  const next: ConversationState = structuredClone(state);
  next.escalation.refAsked = true;
  const waiting = next.escalation.pending;
  next.escalation.pending = [];
  if (waiting.length === 0) return { state: next, results: [] };
  return requestEscalations(repo, conversationId, next, waiting);
}
