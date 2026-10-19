import { createHash, randomUUID } from 'node:crypto';
import { carLabel, getCatalogCar, getOccupation } from '../data/catalog';
import { getUsageIndex, lookupUsageValue } from '../data/usageValues';
import type { Repo } from '../db/repo';
import {
  ConversationStateSchema,
  type Conversation,
  type ConversationState,
  type EscalationSpec,
  type OptionRef,
  type ProfileRecord,
  type RepQuestion,
  type Role,
} from '../db/types';
import { buildComparison, buildTodayOnly, type TodayOnly } from './comparison';
import { missingFieldLabel } from './explain';
import { loadRules } from '../config/rules';
import { flushPendingEscalations, openQuestionNow, requestEscalations, type EscalationResult } from './escalation';
import { applyProvisionalPolicy, showProvisionalAlternative } from './provisionalPolicy';
import { applyRepAnswer } from './repApply';
import { participationFromRepresentative } from './flags';
import { REP_ANSWER_NOTICE, REP_FIELD_PARTICIPATION } from './repFields';
import {
  answerSpecFor,
  EMPLOYEE_REF_MAX,
  isUnknowableField,
  kindOf,
  MAX_REJECTED_ATTEMPTS,
  parseStoredAnswer,
  parseTypedAnswer,
  sanitizeEmployeeRef,
  sanitizeWroteAbout,
  unknownFieldPlan,
  type AnswerSpec,
  type RepKind,
  type UnknowableField,
} from './repQuestions';
import type { CurrentCarInput, ProfileFields } from './schemas';
import type { ComparisonView } from './view';

/**
 * Application services. Rules that hold for EVERY function here:
 *  - the caller is an `Actor`, built only from the verified session cookie (never from a body/query/header/model);
 *  - authorization is checked synchronously BEFORE the first repo call;
 *  - a user can only ever reach their own conversation; the rep can reach questions, never payroll data.
 */

export class ServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(code);
    this.name = 'ServiceError';
  }
}

export interface Actor {
  readonly userId: string;
  readonly role: Role;
}

function requireEmployee(actor: Actor): void {
  if (actor.role !== 'employee') throw new ServiceError(403, 'forbidden');
}
function requireRep(actor: Actor): void {
  if (actor.role !== 'rep') throw new ServiceError(403, 'forbidden');
}

// ---- per-key serialisation: one writer at a time per employee, so an answer is applied exactly once ----
const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

const emptyState = (): ConversationState => ConversationStateSchema.parse({});
const WAIVER_LABEL = 'ויתור על רכב';

// ---------------------------------------------------------------- views

export interface MessageView {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
}

export interface EmployeeQuestionView {
  id: string;
  /** Question kind (see src/lib/repQuestions.ts). */
  kind: RepKind;
  field: string;
  text: string;
  status: 'open' | 'answered';
  carLabel: string | null;
  /** The representative's answer as a number (answered questions only). */
  value: number | null;
  /** True once the answer has been applied to the conversation and the comparison recomputed. */
  applied: boolean;
  createdAt: string;
  answeredAt: string | null;
}

export interface UpdatedField {
  field: string;
  /** The car the answer is about; '' when it is about the employee. */
  carLabel: string;
  /** A number for numeric answers, the chosen option (group letter, occupation, car id ...) otherwise. */
  value: number | string;
}

export interface Updates {
  /** True only on the call that applied new representative answers. */
  newAnswers: boolean;
  updatedFields: UpdatedField[];
}

export interface ProfileView {
  /** Fields whose current value was entered by a representative (the employee can still correct them). */
  fieldSources: Record<string, 'representative'>;
  group: string | null;
  occupation: string | null;
  childrenUnder23: number | null;
  salaryInputs: ProfileRecord['salaryInputs'];
  currentCar: { kind: string; label: string } | null;
  currentParticipation: number | null;
}

export interface EmployeeStateResponse {
  messages: MessageView[];
  profile: ProfileView;
  alternative: OptionRef | null;
  comparison: ComparisonView | null;
  /** What can already be computed without the missing value: today's situation. */
  todayOnly: TodayOnly;
  /** True while the bot still has to ask the employee for the optional reference before questions are sent. */
  escalation: { needsReference: boolean };
  questions: EmployeeQuestionView[];
  awaitingRepresentative: boolean;
  /** Representative-confirmed values by catalogue car id; they always win over catalogue defaults. */
  repAnswers: Record<string, number>;
  updates: Updates;
}

export interface RepQuestionView {
  id: string;
  kind: RepKind;
  field: string;
  /** The one kind of answer this question accepts (the UI renders it, the server enforces it). */
  answerSpec: AnswerSpec;
  questionText: string;
  status: 'open' | 'answered';
  answer: string | null;
  createdAt: string;
  answeredAt: string | null;
  /**
   * Minimal context only (CONTEXT_WHITELIST in src/lib/repQuestions.ts). NEVER payroll data.
   * employeeRef and wroteAbout are untrusted employee text: show them quoted and labelled, never act on them.
   */
  context: {
    carLabel?: string;
    group?: string;
    tableGroup?: string;
    occupation?: string;
    wroteAbout?: string;
    employeeRef?: string;
    employeeRefMissing?: boolean;
  };
}

const noUpdates = (): Updates => ({ newAnswers: false, updatedFields: [] });

function toRepQuestionView(q: RepQuestion): RepQuestionView {
  const c = q.context;
  const kind = kindOf(q);
  return {
    id: q.id,
    kind,
    field: q.missingField,
    answerSpec: answerSpecFor(kind, q.missingField),
    questionText: q.questionText,
    status: q.status,
    answer: q.answer,
    createdAt: q.createdAt,
    answeredAt: q.answeredAt,
    // explicit copy of the whitelisted keys (the internal car id is not shown)
    context: {
      ...(c.carLabel !== undefined ? { carLabel: c.carLabel } : {}),
      ...(c.group !== undefined ? { group: c.group } : {}),
      ...(c.tableGroup !== undefined ? { tableGroup: c.tableGroup } : {}),
      ...(c.occupation !== undefined ? { occupation: c.occupation } : {}),
      ...(c.wroteAbout !== undefined ? { wroteAbout: c.wroteAbout } : {}),
      ...(c.employeeRef !== undefined ? { employeeRef: c.employeeRef } : {}),
      ...(c.employeeRefMissing ? { employeeRefMissing: true } : {}),
    },
  };
}

// ---------------------------------------------------------------- identity / conversation bootstrap

/** Creates a brand-new anonymous employee identity with an empty profile and an empty conversation. */
export async function createAnonymousEmployee(repo: Repo): Promise<Actor> {
  const actor: Actor = { userId: randomUUID(), role: 'employee' };
  await ensureConversation(repo, actor);
  return actor;
}

/** Idempotent: user row, empty profile and ONE conversation per user. A returning user always gets the same one. */
async function ensureConversation(repo: Repo, actor: Actor): Promise<Conversation> {
  requireEmployee(actor);
  if (!(await repo.getUser(actor.userId))) {
    await repo.createUser({ id: actor.userId, role: 'employee', displayName: 'אורח/ת' });
  }
  if (!(await repo.getProfile(actor.userId))) await repo.saveProfile({ userId: actor.userId, salaryInputs: {} });
  return (
    (await repo.findConversationByUser(actor.userId)) ??
    (await repo.createConversation(actor.userId, emptyState()))
  );
}

async function loadProfile(repo: Repo, userId: string): Promise<ProfileRecord> {
  return (await repo.getProfile(userId)) ?? { userId, salaryInputs: {} };
}

// ---------------------------------------------------------------- representative questions

const openQuestionFor = (questions: RepQuestion[], carId: string) =>
  questions.find(
    (q) => q.status === 'open' && q.missingField === REP_FIELD_PARTICIPATION && q.context.carId === carId,
  );

/** Opens (once) the question "what is the employee participation in this car?". Text comes from a template. */
async function ensureRepQuestion(
  repo: Repo,
  conversationId: string,
  carId: string,
  group: string | undefined,
  employeeRef?: string,
): Promise<RepQuestion | null> {
  const car = getCatalogCar(carId);
  if (!car) return null;
  const open = await repo.listRepQuestions({ conversationId, status: 'open' });
  const existing = openQuestionFor(open, carId);
  if (existing) return existing;
  return openQuestionNow(
    repo,
    conversationId,
    {
      kind: 'new_car_participation',
      field: REP_FIELD_PARTICIPATION,
      carId,
      source: { carLabel: carLabel(car), ...(group ? { group } : {}) },
    },
    employeeRef,
  );
}

/** The engine's "missing" field names that an open question of this kind is going to fill. */
function blockedFields(q: RepQuestion): string[] {
  const field = q.missingField;
  switch (kindOf(q)) {
    case 'new_car_participation':
      return ['alternativeParticipation'];
    case 'profile_field_unknown':
    case 'other_missing_field':
      return field === 'occupation' || field === 'occupationDetails' ? ['occupation', 'occupationDetails'] : [field];
    case 'over_budget_gap':
      return ['overBudgetPolicy'];
    case 'unresolved_occupation':
      return ['occupation', 'occupationDetails'];
    case 'unresolved_current_car':
      return ['currentCar', 'currentParticipation'];
    case 'unresolved_alternative_car':
      return ['alternative'];
    case 'group_conflict':
      return ['group'];
  }
}

/**
 * Every comparison view goes through here: it says which open question the comparison is waiting for (so GET state and the
 * chat show the same thing) and which inputs a representative entered (the UI shows "הוזן על ידי נציג" next to them).
 */
function finalizeView(view: ComparisonView, alt: OptionRef, questions: RepQuestion[], state: ConversationState): ComparisonView {
  const open = questions.filter((q) => q.status === 'open');
  const blocking =
    open.find((q) => q.context.carId !== undefined && alt.kind === 'car' && q.context.carId === alt.carId) ??
    open.find((q) => blockedFields(q).some((f) => view.missingFields.includes(f)));
  const age = loadRules().familyTrack.childMaxAge;
  const entered: { field: string; label: string }[] = Object.keys(state.fieldSources).map((field) => ({
    field,
    label: field === 'currentCar' ? 'הרכב הנוכחי' : field === 'alternative' ? 'הרכב להשוואה' : missingFieldLabel(field, age),
  }));
  if (alt.kind === 'car' && state.repAnswers[alt.carId] !== undefined) {
    entered.push({ field: 'alternativeParticipation', label: missingFieldLabel('alternativeParticipation', age) });
  }
  return {
    ...view,
    ...(blocking ? { pendingQuestionId: blocking.id } : {}),
    ...(entered.length > 0 ? { representativeEntered: entered } : {}),
  };
}

/**
 * Recomputes the comparison for the chosen alternative with the real engine and persists state (+ an audit record).
 * The new car's participation is the catalogue default unless a representative has answered. By default the
 * representative is NOT asked: a question exists only when explicitly asked (askRepresentativeParticipation).
 * With PARTICIPATION_FROM_REPRESENTATIVE=true the question is opened automatically while only the default exists.
 */
async function commitComparison(
  repo: Repo,
  conversationId: string,
  state0: ConversationState,
  profile: ProfileRecord,
): Promise<ConversationState> {
  const alt = state0.alternative;
  if (!alt) {
    await repo.saveConversationState(conversationId, state0);
    return state0;
  }
  let state = state0;
  const built = buildComparison({ profile, state, alternative: alt });
  if (built.view.status === 'ok' && built.needsRepresentative && alt.kind === 'car') {
    // only reachable in representative mode (needsRepresentative is always false by default)
    await ensureRepQuestion(repo, conversationId, alt.carId, profile.groupCode, state.escalation.employeeRef);
  }
  // Trigger: a regular car above the group budget. The engine has no gap rule for it, so it can only say "missing".
  if (built.view.status === 'missing' && built.view.missingFields.includes('overBudgetPolicy') && alt.kind === 'car') {
    const car = getCatalogCar(alt.carId);
    if (car) {
      const asked = await requestEscalations(repo, conversationId, state, [
        {
          kind: 'over_budget_gap',
          field: 'overBudgetPolicy',
          carId: car.id,
          source: {
            carLabel: carLabel(car),
            ...(profile.groupCode ? { group: profile.groupCode } : {}),
            ...(profile.occupation ? { occupation: profile.occupation } : {}),
          },
        },
      ]);
      state = asked.state;
    }
  }
  const open = await repo.listRepQuestions({ conversationId, status: 'open' });
  const view = finalizeView(built.view, alt, open, state);
  const next: ConversationState = { ...state, lastComparison: view };
  await repo.saveConversationState(conversationId, next);
  if (view.status === 'ok' && view.meta) {
    await repo.saveCalcResult({
      conversationId,
      scenarioType: 'alternative',
      vehicleRef: alt.kind === 'car' ? alt.carId : 'waiver',
      params: { alternative: alt },
      inputsSnapshot: JSON.parse(JSON.stringify(built.input)) as Record<string, unknown>,
      result: JSON.parse(JSON.stringify(built.result)) as Record<string, unknown>,
      rulesVersion: view.meta.rulesVersion,
      usageDatasetVersion: view.meta.usageDatasetVersion,
    });
  }
  return next;
}

/**
 * Applies every answered, not-yet-applied representative answer exactly once (tracked in appliedAnswerIds):
 * stores the value in the conversation state (it always wins over the catalogue default), recomputes the comparison,
 * and adds the messages. State is saved BEFORE the messages, so a crash can never apply an answer twice.
 */
async function applyAnsweredQuestions(
  repo: Repo,
  conv: Conversation,
  profile0: ProfileRecord,
): Promise<{ conv: Conversation; profile: ProfileRecord; updates: Updates }> {
  const pending = (await repo.listRepQuestions({ conversationId: conv.id, status: 'answered' }))
    .filter((q) => !conv.state.appliedAnswerIds.includes(q.id))
    .sort((a, b) => (a.answeredAt ?? '').localeCompare(b.answeredAt ?? ''));
  if (pending.length === 0) return { conv, profile: profile0, updates: noUpdates() };

  const state: ConversationState = structuredClone(conv.state);
  const profile: ProfileRecord = structuredClone(profile0);
  const applied: { field: string; carLabel: string; value: number | string; message: string }[] = [];
  for (const q of pending) {
    state.appliedAnswerIds.push(q.id); // a stored answer that cannot be applied is still never tried twice
    const done = applyRepAnswer(q, profile, state);
    if (done) applied.push(done);
  }
  // 1. the values (profile) and the "applied" marks (state) are saved before anything is shown, so a crash can never
  //    apply an answer twice (re-writing the same value would be harmless anyway)
  await repo.saveProfile(profile);
  await repo.saveConversationState(conv.id, state);
  // 2. the comparison is recomputed. The engine returns "missing" (never a guessed number) until every needed field exists;
  //    the audit record and the explanation message below are produced only for a complete result.
  const next = await commitComparison(repo, conv.id, state, profile);

  for (const u of applied) await repo.addMessage(conv.id, 'system', u.message);
  if (next.lastComparison?.status === 'ok') {
    await repo.addMessage(conv.id, 'assistant', next.lastComparison.explanation.join('\n'));
  }
  const updatedFields: UpdatedField[] = applied.map(({ field, carLabel, value }) => ({ field, carLabel, value }));
  return { conv: { ...conv, state: next }, profile, updates: { newAnswers: applied.length > 0, updatedFields } };
}

// ---------------------------------------------------------------- employee API

interface Turn {
  conv: Conversation;
  profile: ProfileRecord;
  updates: Updates;
}

async function prepare(repo: Repo, actor: Actor): Promise<Turn> {
  const conv0 = await ensureConversation(repo, actor);
  const profile0 = await loadProfile(repo, actor.userId);
  const { conv, profile, updates } = await applyAnsweredQuestions(repo, conv0, profile0);
  return { conv, profile, updates };
}

function profileView(profile: ProfileRecord, state: ConversationState): ProfileView {
  const cur = state.currentCar;
  let currentCar: ProfileView['currentCar'] = null;
  if (cur) {
    if (cur.kind === 'car') {
      const c = getCatalogCar(cur.carId);
      currentCar = { kind: 'car', label: c ? carLabel(c) : cur.carId };
    } else if (cur.kind === 'dataset') currentCar = { kind: 'dataset', label: cur.label };
    else if (cur.kind === 'waiver') currentCar = { kind: 'waiver', label: WAIVER_LABEL };
    else currentCar = { kind: 'none', label: 'ללא רכב' };
  }
  return {
    fieldSources: { ...state.fieldSources },
    group: profile.groupCode ?? null,
    occupation: profile.occupation ?? null,
    childrenUnder23: profile.childrenCount ?? null,
    salaryInputs: profile.salaryInputs,
    currentCar,
    currentParticipation: state.currentParticipation ?? null,
  };
}

/** The stored answer as a number, for the kinds whose answer is a number; null otherwise. */
function numericAnswer(q: RepQuestion): number | null {
  const stored = parseStoredAnswer(q);
  return stored !== null && answerSpecFor(kindOf(q), q.missingField).type === 'number' ? Number(stored) : null;
}

async function buildStateResponse(repo: Repo, turn: Turn): Promise<EmployeeStateResponse> {
  const { conv, profile, updates } = turn;
  const [messages, questions] = await Promise.all([
    repo.listMessages(conv.id),
    repo.listRepQuestions({ conversationId: conv.id }),
  ]);
  const open = questions.filter((q) => q.status === 'open');
  // Recomputed from saved state on every read: deterministic, so reading is idempotent and has no side effects.
  // The same policy as POST /api/chat (SHOW_PROVISIONAL_ALTERNATIVE): while a question is open both show the same thing.
  const comparison = conv.state.alternative
    ? applyProvisionalPolicy(
        finalizeView(
          buildComparison({ profile, state: conv.state, alternative: conv.state.alternative }).view,
          conv.state.alternative,
          questions,
          conv.state,
        ),
        showProvisionalAlternative(),
      )
    : null;
  return {
    messages: messages.map((m) => ({ id: m.id, role: m.role, content: m.content, createdAt: m.createdAt })),
    profile: profileView(profile, conv.state),
    alternative: conv.state.alternative ?? null,
    comparison,
    todayOnly: buildTodayOnly({ profile, state: conv.state }),
    escalation: { needsReference: conv.state.escalation.pending.length > 0 },
    questions: questions.map((q) => ({
      id: q.id,
      kind: kindOf(q),
      field: q.missingField,
      text: q.questionText,
      status: q.status,
      carLabel: q.context.carLabel ?? null,
      value: q.status === 'answered' ? numericAnswer(q) : null,
      applied: conv.state.appliedAnswerIds.includes(q.id),
      createdAt: q.createdAt,
      answeredAt: q.answeredAt,
    })),
    awaitingRepresentative: open.length > 0,
    repAnswers: conv.state.repAnswers,
    updates,
  };
}

/** The caller's OWN conversation exactly where it stopped, with pending representative answers applied once. */
export async function getEmployeeState(repo: Repo, actor: Actor): Promise<EmployeeStateResponse> {
  requireEmployee(actor);
  return withLock(actor.userId, async () => buildStateResponse(repo, await prepare(repo, actor)));
}

export interface TurnContext {
  state: ConversationState;
  profile: ProfileRecord;
  openQuestions: RepQuestion[];
  updates: Updates;
}

/**
 * Called at the start of every employee turn (the agent uses this next). Applies any answered question first, so the
 * bot already has the representative's data and never asks the employee for it again.
 */
export async function prepareEmployeeTurn(repo: Repo, actor: Actor): Promise<TurnContext> {
  requireEmployee(actor);
  return withLock(actor.userId, async () => {
    const { conv, profile, updates } = await prepare(repo, actor);
    return {
      state: conv.state,
      profile,
      openQuestions: await repo.listRepQuestions({ conversationId: conv.id, status: 'open' }),
      updates,
    };
  });
}

function resolveCurrentCar(input: CurrentCarInput): NonNullable<ConversationState['currentCar']> {
  if (input.kind === 'waiver' || input.kind === 'none') return input;
  if (input.kind === 'car') {
    if (!getCatalogCar(input.carId)) throw new ServiceError(422, 'unknown_car');
    return input;
  }
  const hit = lookupUsageValue(getUsageIndex(), {
    registrationYear: input.registrationYear,
    makerCode: input.makerCode,
    modelCode: input.modelCode,
    vehicleTypeCode: input.vehicleTypeCode,
  });
  if (hit.status !== 'found') throw new ServiceError(422, 'unknown_vehicle');
  const r = hit.row;
  return {
    kind: 'dataset',
    makerCode: input.makerCode,
    modelCode: input.modelCode,
    vehicleTypeCode: input.vehicleTypeCode,
    registrationYear: input.registrationYear,
    // label built by the server from the official dataset, never taken from the client
    label: `${r.makerName} ${r.commercialName || r.modelDescription} (${r.registrationYear})`,
  };
}

/** Saves what the employee says about themselves and recomputes the chosen alternative, if any. */
export async function updateProfile(repo: Repo, actor: Actor, fields: ProfileFields): Promise<EmployeeStateResponse> {
  requireEmployee(actor);
  return withLock(actor.userId, async () => {
    const turn = await prepare(repo, actor);
    const { conv } = turn;
    const old = turn.profile;

    const salaryInputs = { ...old.salaryInputs };
    for (const k of ['base', 'commissions', 'bonus', 'pensionPct', 'studyFundPct', 'creditPoints'] as const) {
      if (fields[k] !== undefined) salaryInputs[k] = fields[k];
    }
    const profile: ProfileRecord = {
      userId: actor.userId,
      salaryInputs,
      groupCode: fields.group ?? old.groupCode,
      childrenCount: fields.childrenUnder23 ?? old.childrenCount,
      occupation: fields.occupation ?? old.occupation,
    };
    const state: ConversationState = { ...conv.state, fieldSources: { ...conv.state.fieldSources }, escalation: { ...conv.state.escalation, attempts: { ...conv.state.escalation.attempts } } };
    for (const key of Object.keys(fields)) {
      const field = key === 'currentCar' ? 'currentCar' : key;
      delete state.fieldSources[field]; // the employee's own value replaces the representative's
      delete state.escalation.attempts[`reject:${field}`];
    }
    if (fields.currentCar !== undefined) state.currentCar = resolveCurrentCar(fields.currentCar);
    if (fields.currentParticipation !== undefined) state.currentParticipation = fields.currentParticipation;

    await repo.saveProfile(profile);
    const next = await commitComparison(repo, conv.id, state, profile);
    return buildStateResponse(repo, { conv: { ...conv, state: next }, profile, updates: turn.updates });
  });
}

/** Chooses the alternative to compare (a catalogue car or giving up the car). */
export async function selectAlternative(repo: Repo, actor: Actor, alternative: OptionRef): Promise<EmployeeStateResponse> {
  requireEmployee(actor);
  if (alternative.kind === 'car' && !getCatalogCar(alternative.carId)) throw new ServiceError(422, 'unknown_car');
  return withLock(actor.userId, async () => {
    const turn = await prepare(repo, actor);
    const next = await commitComparison(repo, turn.conv.id, { ...turn.conv.state, alternative }, turn.profile);
    return buildStateResponse(repo, { ...turn, conv: { ...turn.conv, state: next } });
  });
}

// ---------------------------------------------------------------- representative API

export const REP_ANSWER_REJECTED_NOTICE = 'נציג התחבורה ניסה להשיב, אבל התשובה לא הייתה תקינה. השאלה עדיין פתוחה וממתינה לתשובה.';

/** Tells the employee that the question is still open after an invalid answer (once per run of rejections). */
async function tellEmployeeStillOpen(repo: Repo, conversationId: string): Promise<void> {
  const last = (await repo.listMessages(conversationId)).at(-1);
  if (last?.role === 'system' && last.content === REP_ANSWER_REJECTED_NOTICE) return;
  await repo.addMessage(conversationId, 'system', REP_ANSWER_REJECTED_NOTICE);
}

/** Open questions first, then answered. Carries only the question, the car label, the group and the field. */
export async function listRepQuestions(repo: Repo, actor: Actor): Promise<RepQuestionView[]> {
  requireRep(actor);
  const all = await repo.listRepQuestions();
  const rank = (q: RepQuestion) => (q.status === 'open' ? 0 : 1);
  return all
    .sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt))
    .map(toRepQuestionView);
}

/** Answers a question once. Never overwrites; 404 if unknown; the answer is parsed into a number or rejected. */
export async function answerRepQuestion(
  repo: Repo,
  actor: Actor,
  input: { questionId: string; answer: string },
): Promise<RepQuestionView> {
  requireRep(actor);
  const q = await repo.getRepQuestion(input.questionId);
  if (!q) throw new ServiceError(404, 'question_not_found');
  if (q.status !== 'open') throw new ServiceError(409, 'already_answered');
  const value = parseTypedAnswer(answerSpecFor(kindOf(q), q.missingField), input.answer);
  if (value === null) {
    await tellEmployeeStillOpen(repo, q.conversationId);
    throw new ServiceError(400, 'invalid_answer');
  }
  // Conditional write: if two reps race, only one wins and the other gets 409.
  const saved = await repo.answerRepQuestion(q.id, value);
  if (!saved) throw new ServiceError(409, 'already_answered');
  // The employee's conversation gets a system notice now; the value is applied when they next load / write.
  await repo.addMessage(q.conversationId, 'system', REP_ANSWER_NOTICE);
  return toRepQuestionView(saved);
}

// ---------------------------------------------------------------- agent support

export interface AskRepresentativeResult {
  status: 'asked' | 'already_open' | 'already_answered';
  questionId?: string;
}

/**
 * Used by the agent's ask_representative tool. Opens (once) the participation question for a catalogue car.
 * The question text comes from a template; nothing the model or the employee wrote reaches the representative.
 */
export async function askRepresentativeParticipation(
  repo: Repo,
  actor: Actor,
  carId: string,
): Promise<AskRepresentativeResult> {
  requireEmployee(actor);
  if (!getCatalogCar(carId)) throw new ServiceError(422, 'unknown_car');
  return withLock(actor.userId, async () => {
    const turn = await prepare(repo, actor);
    if (turn.conv.state.repAnswers[carId] !== undefined) return { status: 'already_answered' };
    const open = await repo.listRepQuestions({ conversationId: turn.conv.id, status: 'open' });
    const existing = openQuestionFor(open, carId);
    if (existing) return { status: 'already_open', questionId: existing.id };
    const q = await ensureRepQuestion(repo, turn.conv.id, carId, turn.profile.groupCode);
    return q ? { status: 'asked', questionId: q.id } : { status: 'already_open' };
  });
}

// ---------------------------------------------------------------- representative escalation (decided by SERVER code only)

/** Outcome per case, as reported to the bot. "already_known" = the profile already has the value, so nothing is asked. */
export type EscalationReport = { kind: string; field: string; carId?: string; outcome: EscalationResult['outcome'] | 'already_known' | 'server_only' };

export interface EscalationReply {
  results: EscalationReport[];
  /** True while the bot must ask the employee (once) for the optional reference before the questions are sent. */
  needsReference: boolean;
}

/** Runs `fn` on the employee's turn under the per-employee lock and saves the state it returns, if it changed. */
async function escalate(
  repo: Repo,
  actor: Actor,
  fn: (turn: Turn) => Promise<{ state: ConversationState; results: EscalationReport[] } | null>,
): Promise<EscalationReply> {
  requireEmployee(actor);
  return withLock(actor.userId, async () => {
    const turn = await prepare(repo, actor);
    const out = await fn(turn);
    if (!out) return { results: [], needsReference: turn.conv.state.escalation.pending.length > 0 };
    if (JSON.stringify(out.state) !== JSON.stringify(turn.conv.state)) await repo.saveConversationState(turn.conv.id, out.state);
    return { results: out.results, needsReference: out.state.escalation.pending.length > 0 };
  });
}

/** Does the employee's saved data already have this field? Then there is nothing to ask a representative. */
function hasValue(profile: ProfileRecord, state: ConversationState, f: UnknowableField): boolean {
  switch (f) {
    case 'group':
      return profile.groupCode !== undefined;
    case 'childrenUnder23':
      return profile.childrenCount !== undefined;
    case 'currentParticipation':
      return state.currentParticipation !== undefined;
    case 'occupation':
    case 'occupationDetails':
      return profile.occupation !== undefined;
    case 'currentCar':
    case 'currentCarMaker':
    case 'currentCarModel':
    case 'currentCarYear':
      return state.currentCar !== undefined;
    case 'alternative':
      return state.alternative !== undefined;
    case 'alternativeParticipation':
    case 'overBudgetPolicy':
      return false;
    default:
      return profile.salaryInputs[f] !== undefined;
  }
}

/** The question to open for this field (from the ONE plan table in repQuestions.ts), or why none is opened. */
function specForField(
  profile: ProfileRecord,
  state: ConversationState,
  field: UnknowableField,
): { spec: EscalationSpec } | { outcome: EscalationReport['outcome'] } {
  if (hasValue(profile, state, field)) return { outcome: 'already_known' };
  const plan = unknownFieldPlan(field);
  if (plan.type === 'server_only') return { outcome: 'server_only' };
  const occupation: Record<string, string> = profile.occupation ? { occupation: profile.occupation } : {};
  if (plan.type === 'participation') {
    // behind PARTICIPATION_FROM_REPRESENTATIVE, and only for the car that is being compared
    const alt = state.alternative;
    const car = alt?.kind === 'car' ? getCatalogCar(alt.carId) : undefined;
    if (!participationFromRepresentative() || !car) return { outcome: 'not_needed' };
    return {
      spec: {
        kind: 'new_car_participation',
        field: REP_FIELD_PARTICIPATION,
        carId: car.id,
        source: { carLabel: carLabel(car), ...(profile.groupCode ? { group: profile.groupCode } : {}) },
      },
    };
  }
  return { spec: { kind: plan.kind, field: plan.field, source: { field: plan.part ?? plan.field, ...occupation } } };
}

/**
 * The employee said she does not know / does not have these fields (a structured marker from the bot's tool). Works for EVERY
 * field the engine can report as missing. The server, not the model, decides what happens: a field the employee data already
 * has is never escalated; the rest go through requestEscalations (once per case, capped, reference prompt first).
 */
export function reportUnknownFields(repo: Repo, actor: Actor, fields: UnknowableField[]): Promise<EscalationReply> {
  return escalate(repo, actor, async ({ conv, profile }) => {
    const results: EscalationReport[] = [];
    const specs: EscalationSpec[] = [];
    for (const field of new Set(fields)) {
      const planned = specForField(profile, conv.state, field);
      if ('spec' in planned) specs.push(planned.spec);
      else results.push({ kind: 'profile_field_unknown', field, outcome: planned.outcome });
    }
    const asked = await requestEscalations(repo, conv.id, conv.state, specs);
    return { state: asked.state, results: [...results, ...asked.results] };
  });
}

/**
 * A value for this field was REJECTED (not written by the employee, or out of range). The 3rd rejection of the same field
 * stops the loop: the server opens ONE question for it instead of asking the employee again. A saved value resets the count.
 */
export function noteRejectedFields(repo: Repo, actor: Actor, fields: string[]): Promise<EscalationReply> {
  return escalate(repo, actor, async ({ conv, profile }) => {
    const state: ConversationState = structuredClone(conv.state);
    const specs: EscalationSpec[] = [];
    for (const f of new Set(fields)) {
      if (!isUnknowableField(f) || f === 'occupation') continue; // an unknown occupation has its own rule (noteUnresolved)
      const key = `reject:${f}`;
      const n = (state.escalation.attempts[key] ?? 0) + 1;
      state.escalation.attempts[key] = n;
      if (n < MAX_REJECTED_ATTEMPTS) continue;
      const planned = specForField(profile, state, f);
      if ('spec' in planned) specs.push(planned.spec);
    }
    if (specs.length === 0) return { state, results: [] };
    const asked = await requestEscalations(repo, conv.id, state, specs);
    return { state: asked.state, results: asked.results };
  });
}

/** The employee answered (or skipped) the reference prompt: store it (sanitised, untrusted) and open what was waiting. */
export function provideEmployeeReference(repo: Repo, actor: Actor, employeeRef: string | undefined): Promise<EscalationReply> {
  return escalate(repo, actor, async ({ conv }) => {
    const ref = employeeRef === undefined ? '' : sanitizeEmployeeRef(employeeRef).slice(0, EMPLOYEE_REF_MAX);
    const state: ConversationState = structuredClone(conv.state);
    if (ref !== '') state.escalation.employeeRef = ref;
    const flushed = await flushPendingEscalations(repo, conv.id, state);
    return { state: flushed.state, results: flushed.results };
  });
}

/** End of a turn: if the reference prompt was shown in an EARLIER turn, the questions are opened now, with or without it. */
export function flushEscalations(repo: Repo, actor: Actor): Promise<EscalationReply> {
  return escalate(repo, actor, async ({ conv }) => {
    if (conv.state.escalation.pending.length === 0) return null;
    const flushed = await flushPendingEscalations(repo, conv.id, conv.state);
    return { state: flushed.state, results: flushed.results };
  });
}

/** A value that could not be resolved (an occupation that is not in the table). The 2nd time the representative is asked. */
export async function noteUnresolved(
  repo: Repo,
  actor: Actor,
  what: 'occupation',
  text: string,
): Promise<EscalationReply & { attempts: number }> {
  let attempts = 0;
  const reply = await escalate(repo, actor, async ({ conv }) => {
    const state: ConversationState = structuredClone(conv.state);
    attempts = (state.escalation.attempts[what] ?? 0) + 1;
    state.escalation.attempts[what] = attempts;
    if (attempts < 2) return { state, results: [] };
    const asked = await requestEscalations(repo, conv.id, state, [
      { kind: 'unresolved_occupation', field: what, source: { wroteAbout: sanitizeWroteAbout(text) } },
    ]);
    return { state: asked.state, results: asked.results };
  });
  return { ...reply, attempts };
}

export interface UnresolvedCar {
  role: 'current' | 'alternative';
  /** What the employee wrote about the car (the caller passes the clause; it is sanitised here). */
  text: string;
  /** Identifies the car itself (maker/model words + year), so the same car described twice is ONE case. */
  key: string;
}

const shortHash = (s: string) => createHash('sha256').update(s.toLowerCase()).digest('hex').slice(0, 8);

/**
 * Deterministic triggers evaluated at the start of every employee turn:
 *  - a car that could not be found after full details (maker, model, year) were given;
 *  - the stated group contradicts the occupation table: the bot asks the employee ONCE, and if it is still contradicting
 *    on a later turn the representative is asked.
 */
export function evaluateTurnTriggers(repo: Repo, actor: Actor, input: { unresolvedCars: UnresolvedCar[] }): Promise<EscalationReply> {
  return escalate(repo, actor, async ({ conv, profile }) => {
    let state: ConversationState = structuredClone(conv.state);
    const results: EscalationReport[] = [];
    const specs: EscalationSpec[] = [];

    for (const c of input.unresolvedCars) {
      const wroteAbout = sanitizeWroteAbout(c.text);
      if (wroteAbout === '') continue;
      specs.push({
        kind: c.role === 'current' ? 'unresolved_current_car' : 'unresolved_alternative_car',
        // the employee has ONE current car; alternatives are told apart by the car named
        field: c.role === 'current' ? 'currentCar' : `alternativeCar:${shortHash(c.key)}`,
        source: {
          wroteAbout,
          ...(profile.occupation ? { occupation: profile.occupation } : {}),
          ...(c.role === 'alternative' && profile.groupCode ? { group: profile.groupCode } : {}),
        },
      });
    }

    const occupation = profile.occupation ? getOccupation(profile.occupation) : undefined;
    if (profile.groupCode && occupation && occupation.group !== profile.groupCode) {
      if (!state.escalation.groupConflictAsked) state.escalation.groupConflictAsked = true; // the bot asks the employee now
      else {
        specs.push({
          kind: 'group_conflict',
          field: 'group',
          source: { group: profile.groupCode, tableGroup: occupation.group, occupation: occupation.name },
        });
      }
    } else if (state.escalation.groupConflictAsked) {
      state.escalation.groupConflictAsked = false; // resolved
    }

    if (specs.length > 0) {
      const asked = await requestEscalations(repo, conv.id, state, specs);
      state = asked.state;
      results.push(...asked.results);
    }
    return { state, results };
  });
}

export interface QuestionStatusView {
  kind: RepKind;
  field: string;
  carId?: string;
  status: 'open' | 'answered';
}

/** What the bot may report about questions: kind, field and status only. It cannot open one. */
export async function listQuestionStatus(repo: Repo, actor: Actor): Promise<{ questions: QuestionStatusView[]; needsReference: boolean }> {
  requireEmployee(actor);
  return withLock(actor.userId, async () => {
    const { conv } = await prepare(repo, actor);
    const all = await repo.listRepQuestions({ conversationId: conv.id });
    return {
      questions: all.map((q) => ({ kind: kindOf(q), field: q.missingField, ...(q.context.carId ? { carId: q.context.carId } : {}), status: q.status })),
      needsReference: conv.state.escalation.pending.length > 0,
    };
  });
}
