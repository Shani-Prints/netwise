import { randomUUID } from 'node:crypto';
import { carLabel, getCatalogCar } from '../data/catalog';
import { getUsageIndex, lookupUsageValue } from '../data/usageValues';
import type { Repo } from '../db/repo';
import type {
  Conversation,
  ConversationState,
  OptionRef,
  ProfileRecord,
  RepQuestion,
  Role,
} from '../db/types';
import { buildComparison, buildTodayOnly, type TodayOnly } from './comparison';
import { fmt } from './explain';
import {
  isRepField,
  parseRepAnswer,
  participationQuestionText,
  REP_ANSWER_NOTICE,
  REP_FIELD_PARTICIPATION,
} from './repFields';
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

const emptyState = (): ConversationState => ({ repAnswers: {}, appliedAnswerIds: [] });
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
  carLabel: string;
  value: number;
}

export interface Updates {
  /** True only on the call that applied new representative answers. */
  newAnswers: boolean;
  updatedFields: UpdatedField[];
}

export interface ProfileView {
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
  questions: EmployeeQuestionView[];
  awaitingRepresentative: boolean;
  /** Representative-confirmed values by catalogue car id; they always win over catalogue defaults. */
  repAnswers: Record<string, number>;
  updates: Updates;
}

export interface RepQuestionView {
  id: string;
  field: string;
  questionText: string;
  status: 'open' | 'answered';
  answer: string | null;
  createdAt: string;
  answeredAt: string | null;
  /** Minimal context only. NEVER payroll data. */
  context: { carLabel?: string; group?: string };
}

const noUpdates = (): Updates => ({ newAnswers: false, updatedFields: [] });

function toRepQuestionView(q: RepQuestion): RepQuestionView {
  return {
    id: q.id,
    field: q.missingField,
    questionText: q.questionText,
    status: q.status,
    answer: q.answer,
    createdAt: q.createdAt,
    answeredAt: q.answeredAt,
    context: {
      ...(q.context.carLabel !== undefined ? { carLabel: q.context.carLabel } : {}),
      ...(q.context.group !== undefined ? { group: q.context.group } : {}),
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
): Promise<RepQuestion | null> {
  const car = getCatalogCar(carId);
  if (!car) return null;
  const open = await repo.listRepQuestions({ conversationId, status: 'open' });
  const existing = openQuestionFor(open, carId);
  if (existing) return existing;
  const label = carLabel(car);
  return repo.createRepQuestion({
    conversationId,
    missingField: REP_FIELD_PARTICIPATION,
    questionText: participationQuestionText(label, group),
    context: { carId, carLabel: label, ...(group ? { group } : {}) },
  });
}

function withPending(view: ComparisonView, alt: OptionRef, questions: RepQuestion[]): ComparisonView {
  if (alt.kind !== 'car') return view;
  const q = openQuestionFor(questions, alt.carId);
  return q ? { ...view, pendingQuestionId: q.id } : view;
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
  state: ConversationState,
  profile: ProfileRecord,
): Promise<ConversationState> {
  if (!state.alternative) {
    await repo.saveConversationState(conversationId, state);
    return state;
  }
  const built = buildComparison({ profile, state, alternative: state.alternative });
  if (built.view.status === 'ok' && built.needsRepresentative && state.alternative.kind === 'car') {
    // only reachable in representative mode (needsRepresentative is always false by default)
    await ensureRepQuestion(repo, conversationId, state.alternative.carId, profile.groupCode);
  }
  const open = await repo.listRepQuestions({ conversationId, status: 'open' });
  const view = withPending(built.view, state.alternative, open);
  const next: ConversationState = { ...state, lastComparison: view };
  await repo.saveConversationState(conversationId, next);
  if (view.status === 'ok' && view.meta) {
    await repo.saveCalcResult({
      conversationId,
      scenarioType: 'alternative',
      vehicleRef: state.alternative.kind === 'car' ? state.alternative.carId : 'waiver',
      params: { alternative: state.alternative },
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
  profile: ProfileRecord,
): Promise<{ conv: Conversation; updates: Updates }> {
  const pending = (await repo.listRepQuestions({ conversationId: conv.id, status: 'answered' }))
    .filter((q) => !conv.state.appliedAnswerIds.includes(q.id))
    .sort((a, b) => (a.answeredAt ?? '').localeCompare(b.answeredAt ?? ''));
  if (pending.length === 0) return { conv, updates: noUpdates() };

  const state: ConversationState = structuredClone(conv.state);
  const updatedFields: UpdatedField[] = [];
  for (const q of pending) {
    state.appliedAnswerIds.push(q.id);
    const value = parseRepAnswer(q.missingField, q.answer ?? '');
    const carId = q.context.carId;
    if (value === null || !carId || !isRepField(q.missingField)) continue;
    state.repAnswers[carId] = value;
    updatedFields.push({ field: q.missingField, carLabel: q.context.carLabel ?? '', value });
  }
  await repo.saveConversationState(conv.id, state); // marks the answers applied first
  const next = await commitComparison(repo, conv.id, state, profile);

  for (const u of updatedFields) {
    await repo.addMessage(
      conv.id,
      'system',
      `התקבל עדכון מנציג התחבורה: ההשתתפות שלך ברכב "${u.carLabel}" היא ${fmt(u.value)} ₪. החישוב עודכן בהתאם.`,
    );
  }
  if (next.lastComparison?.status === 'ok') {
    await repo.addMessage(conv.id, 'assistant', next.lastComparison.explanation.join('\n'));
  }
  return { conv: { ...conv, state: next }, updates: { newAnswers: updatedFields.length > 0, updatedFields } };
}

// ---------------------------------------------------------------- employee API

interface Turn {
  conv: Conversation;
  profile: ProfileRecord;
  updates: Updates;
}

async function prepare(repo: Repo, actor: Actor): Promise<Turn> {
  const conv0 = await ensureConversation(repo, actor);
  const profile = await loadProfile(repo, actor.userId);
  const { conv, updates } = await applyAnsweredQuestions(repo, conv0, profile);
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
    group: profile.groupCode ?? null,
    occupation: profile.occupation ?? null,
    childrenUnder23: profile.childrenCount ?? null,
    salaryInputs: profile.salaryInputs,
    currentCar,
    currentParticipation: state.currentParticipation ?? null,
  };
}

async function buildStateResponse(repo: Repo, turn: Turn): Promise<EmployeeStateResponse> {
  const { conv, profile, updates } = turn;
  const [messages, questions] = await Promise.all([
    repo.listMessages(conv.id),
    repo.listRepQuestions({ conversationId: conv.id }),
  ]);
  const open = questions.filter((q) => q.status === 'open');
  // Recomputed from saved state on every read: deterministic, so reading is idempotent and has no side effects.
  const comparison = conv.state.alternative
    ? withPending(
        buildComparison({ profile, state: conv.state, alternative: conv.state.alternative }).view,
        conv.state.alternative,
        open,
      )
    : null;
  return {
    messages: messages.map((m) => ({ id: m.id, role: m.role, content: m.content, createdAt: m.createdAt })),
    profile: profileView(profile, conv.state),
    alternative: conv.state.alternative ?? null,
    comparison,
    todayOnly: buildTodayOnly({ profile, state: conv.state }),
    questions: questions.map((q) => ({
      id: q.id,
      field: q.missingField,
      text: q.questionText,
      status: q.status,
      carLabel: q.context.carLabel ?? null,
      value: q.status === 'answered' ? parseRepAnswer(q.missingField, q.answer ?? '') : null,
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
    const state: ConversationState = { ...conv.state };
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
  const value = parseRepAnswer(q.missingField, input.answer);
  if (value === null) throw new ServiceError(400, 'invalid_answer');
  // Conditional write: if two reps race, only one wins and the other gets 409.
  const saved = await repo.answerRepQuestion(q.id, String(value));
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
