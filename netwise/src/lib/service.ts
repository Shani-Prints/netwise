import { z } from 'zod';
import { GroupCodeSchema } from '../config/rulesSchema';
import { getRepo, type Repo } from '../db/repo';
import { ConversationStateSchema, SalaryInputsSchema } from '../db/types';
import type {
  CalcRecord,
  Conversation,
  ConversationState,
  Message,
  MessageRole,
  ProfileRecord,
  RepQuestion,
  Role,
  User,
} from '../db/types';

/**
 * Authorization lives here, because the server talks to Supabase with the service-role key (RLS is bypassed).
 *
 *   employee: only her own data (profile, conversation, messages, scenarios, calc results, her own rep questions).
 *   rep:      read and modify all employees' data and answer rep questions; users are read-only.
 *
 * Every function takes the `actor` supplied by the session layer (never by a request body or query string).
 * The actor is re-checked against public.users on every call, so a stale or forged role is rejected.
 * An employee who asks for another employee's resource gets the same `not_found` as for a missing one.
 */
export interface Actor {
  userId: string;
  role: Role;
}

const STATUS = { unauthorized: 401, forbidden: 403, not_found: 404, conflict: 409, bad_request: 400 } as const;
export type ServiceErrorCode = keyof typeof STATUS;

export class ServiceError extends Error {
  readonly status: number;
  constructor(
    readonly code: ServiceErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ServiceError';
    this.status = STATUS[code];
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new ServiceError('not_found');

interface Ctx {
  repo: Repo;
  me: User;
}

async function authenticate(actor: Actor | null | undefined): Promise<Ctx> {
  if (!actor || typeof actor.userId !== 'string' || !UUID.test(actor.userId)) throw new ServiceError('unauthorized');
  const repo = await getRepo();
  const me = await repo.getUser(actor.userId);
  if (!me || me.role !== actor.role) throw new ServiceError('unauthorized');
  return { repo, me };
}

function requireRep({ me }: Ctx): void {
  if (me.role !== 'rep') throw new ServiceError('forbidden');
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ServiceError('bad_request', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}

/** The employee whose data is addressed. Employees always get themselves (any other id is "not found"). */
async function resolveEmployeeId({ repo, me }: Ctx, targetUserId?: string): Promise<string> {
  if (me.role === 'employee') {
    if (targetUserId !== undefined && targetUserId !== me.id) throw notFound();
    return me.id;
  }
  if (!targetUserId) throw new ServiceError('bad_request', 'targetUserId is required for a rep');
  if (!UUID.test(targetUserId)) throw notFound();
  const target = await repo.getUser(targetUserId);
  if (!target || target.role !== 'employee') throw notFound();
  return target.id;
}

async function ownedConversation({ repo, me }: Ctx, conversationId: string): Promise<Conversation> {
  if (typeof conversationId !== 'string' || !UUID.test(conversationId)) throw notFound();
  const c = await repo.getConversation(conversationId);
  if (!c || (me.role === 'employee' && c.userId !== me.id)) throw notFound();
  return c;
}

// ---- users -------------------------------------------------------------------------------------------------------

/** Rep: all users (read-only). Employee: only herself. */
export async function listUsers(actor: Actor | null | undefined): Promise<User[]> {
  const ctx = await authenticate(actor);
  return ctx.me.role === 'rep' ? ctx.repo.listUsers() : [ctx.me];
}

export async function getUser(actor: Actor | null | undefined, userId: string): Promise<User> {
  const ctx = await authenticate(actor);
  if (ctx.me.role === 'employee') {
    if (userId !== ctx.me.id) throw notFound();
    return ctx.me;
  }
  if (!UUID.test(userId)) throw notFound();
  const u = await ctx.repo.getUser(userId);
  if (!u) throw notFound();
  return u;
}

// ---- profiles ----------------------------------------------------------------------------------------------------

/** Only these fields are accepted; anything else in the input (a userId, a role) is stripped. */
const ProfileInputSchema = z.object({
  salaryInputs: SalaryInputsSchema,
  groupCode: GroupCodeSchema.optional(),
  childrenCount: z.number().int().min(0).optional(),
  occupation: z.string().max(200).optional(),
});

export async function getProfile(actor: Actor | null | undefined, targetUserId?: string): Promise<ProfileRecord | null> {
  const ctx = await authenticate(actor);
  return ctx.repo.getProfile(await resolveEmployeeId(ctx, targetUserId));
}

export async function saveProfile(actor: Actor | null | undefined, input: unknown, targetUserId?: string): Promise<void> {
  const ctx = await authenticate(actor);
  const userId = await resolveEmployeeId(ctx, targetUserId);
  await ctx.repo.saveProfile({ userId, ...parse(ProfileInputSchema, input) });
}

// ---- conversations -----------------------------------------------------------------------------------------------

export async function getConversation(actor: Actor | null | undefined, conversationId: string): Promise<Conversation> {
  return ownedConversation(await authenticate(actor), conversationId);
}

export async function getOrCreateConversation(
  actor: Actor | null | undefined,
  targetUserId?: string,
  initialState: ConversationState = { repAnswers: {}, appliedAnswerIds: [] },
): Promise<Conversation> {
  const ctx = await authenticate(actor);
  const userId = await resolveEmployeeId(ctx, targetUserId);
  const existing = await ctx.repo.findConversationByUser(userId);
  if (existing) return existing;
  const state = parse(ConversationStateSchema, initialState);
  // Only a rep may seed rep-confirmed fields.
  if (ctx.me.role === 'employee') Object.assign(state, { repAnswers: {}, appliedAnswerIds: [] });
  return ctx.repo.createConversation(userId, state);
}

export async function saveConversationState(actor: Actor | null | undefined, conversationId: string, state: unknown): Promise<void> {
  const ctx = await authenticate(actor);
  const existing = await ownedConversation(ctx, conversationId);
  const next = parse(ConversationStateSchema, state);
  // Rep-confirmed participation (and which answers were applied) must not be forgeable by the employee.
  if (ctx.me.role === 'employee') {
    next.repAnswers = existing.state.repAnswers;
    next.appliedAnswerIds = existing.state.appliedAnswerIds;
  }
  await ctx.repo.saveConversationState(existing.id, next);
}

// ---- messages ----------------------------------------------------------------------------------------------------

const ContentSchema = z.string().trim().min(1).max(8000);

async function appendMessage(actor: Actor | null | undefined, conversationId: string, role: MessageRole, content: unknown): Promise<Message> {
  const ctx = await authenticate(actor);
  const c = await ownedConversation(ctx, conversationId);
  return ctx.repo.addMessage(c.id, role, parse(ContentSchema, content));
}

/** A chat message typed by the actor. The role is fixed to 'user': it can never come from a request body. */
export function addMessage(actor: Actor | null | undefined, conversationId: string, content: unknown): Promise<Message> {
  return appendMessage(actor, conversationId, 'user', content);
}

/** The assistant's reply. SERVER-SIDE ONLY: call it with model output, never expose it as an endpoint taking text. */
export function addAssistantMessage(actor: Actor | null | undefined, conversationId: string, content: unknown): Promise<Message> {
  return appendMessage(actor, conversationId, 'assistant', content);
}

export async function listMessages(actor: Actor | null | undefined, conversationId: string, limit?: number): Promise<Message[]> {
  const ctx = await authenticate(actor);
  const c = await ownedConversation(ctx, conversationId);
  const n = Number.isFinite(limit) ? Math.trunc(limit as number) : 200;
  return ctx.repo.listMessages(c.id, Math.min(Math.max(n, 1), 500));
}

// ---- scenarios / calculation results -----------------------------------------------------------------------------

/**
 * Ownership is checked, but the CONTENT (inputsSnapshot/result) is trusted: it must be engine output computed on the
 * server, never data taken from a request body.
 */
export async function saveCalcResult(actor: Actor | null | undefined, rec: CalcRecord): Promise<void> {
  const ctx = await authenticate(actor);
  const c = await ownedConversation(ctx, rec.conversationId);
  await ctx.repo.saveCalcResult({ ...rec, conversationId: c.id });
}

export async function listCalcResults(actor: Actor | null | undefined, conversationId: string): Promise<CalcRecord[]> {
  const ctx = await authenticate(actor);
  const c = await ownedConversation(ctx, conversationId);
  return ctx.repo.listCalcResults(c.id);
}

// ---- rep questions -----------------------------------------------------------------------------------------------

const RepQuestionInputSchema = z.object({
  missingField: z.string().min(1).max(100),
  questionText: z.string().trim().min(1).max(2000),
  context: z.object({ carId: z.string().max(100).optional(), carLabel: z.string().max(200).optional(), group: z.string().max(10).optional() }),
});

export async function createRepQuestion(actor: Actor | null | undefined, conversationId: string, input: unknown): Promise<RepQuestion> {
  const ctx = await authenticate(actor);
  const c = await ownedConversation(ctx, conversationId);
  return ctx.repo.createRepQuestion({ conversationId: c.id, ...parse(RepQuestionInputSchema, input) });
}

/** Rep: any question (optionally filtered). Employee: only questions of her own conversation. */
export async function listRepQuestions(
  actor: Actor | null | undefined,
  filter?: { status?: 'open' | 'answered'; conversationId?: string },
): Promise<RepQuestion[]> {
  const ctx = await authenticate(actor);
  if (ctx.me.role === 'rep') {
    if (filter?.conversationId !== undefined && !UUID.test(filter.conversationId)) throw notFound();
    return ctx.repo.listRepQuestions(filter);
  }
  const mine = await ctx.repo.findConversationByUser(ctx.me.id);
  if (filter?.conversationId !== undefined && filter.conversationId !== mine?.id) throw notFound();
  if (!mine) return [];
  return ctx.repo.listRepQuestions({ status: filter?.status, conversationId: mine.id });
}

export async function getRepQuestion(actor: Actor | null | undefined, id: string): Promise<RepQuestion> {
  const ctx = await authenticate(actor);
  return loadQuestion(ctx, id);
}

async function loadQuestion(ctx: Ctx, id: string): Promise<RepQuestion> {
  if (typeof id !== 'string' || !UUID.test(id)) throw notFound();
  const q = await ctx.repo.getRepQuestion(id);
  if (!q) throw notFound();
  if (ctx.me.role === 'employee') await ownedConversation(ctx, q.conversationId); // 404 if it is not hers
  return q;
}

export async function answerRepQuestion(actor: Actor | null | undefined, id: string, answer: unknown): Promise<RepQuestion> {
  const ctx = await authenticate(actor);
  requireRep(ctx);
  const text = parse(z.string().trim().min(1).max(2000), answer);
  const q = await loadQuestion(ctx, id);
  if (q.status !== 'open') throw new ServiceError('conflict', 'question already answered');
  const updated = await ctx.repo.answerRepQuestion(q.id, text);
  if (!updated) throw new ServiceError('conflict', 'question already answered'); // lost a race with another answer
  return updated;
}
