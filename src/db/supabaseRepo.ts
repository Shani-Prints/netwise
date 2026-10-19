import type { SupabaseClient } from '@supabase/supabase-js';
import { describeError } from '../lib/errorLog';
import { createAdminClient } from './adminClient';
import { ConversationStateSchema, SalaryInputsSchema } from './types';
import type { Repo } from './repo';
import type { Conversation, Message, ProfileRecord, RepQuestion, User } from './types';

type Row = Record<string, unknown>;

/**
 * Logs and returns a database failure. The text has the method, then the error name, code, message and cause (fetch failed,
 * ECONNRESET ...). When the client's error has no message the code or the cause is shown instead of "undefined".
 * Row details/hints, keys and employee data are never included.
 */
export function supabaseFailure(what: string, error: object): Error {
  const e = error as { message?: unknown; code?: unknown; cause?: unknown };
  const noInfo = !e.message && !e.code && !e.cause;
  const text = `supabase ${what} failed: ${describeError(error, true)}${noInfo ? ' (the client gave no message, code or cause)' : ''}`;
  console.error(`[netwise] ${text}`);
  return new Error(text, { cause: error });
}

function must<T>(res: { data: T; error: object | null }, what: string): T {
  if (res.error) throw supabaseFailure(what, res.error);
  return res.data;
}

/** List queries: Supabase types allow null data; with no error it simply means no rows. */
function mustRows<T>(res: { data: T[] | null; error: object | null }, what: string): T[] {
  return must(res, what) ?? [];
}

/** Queries that must return exactly one row (insert ... select().single()): null here is a real failure. */
function mustOne<T>(res: { data: T; error: object | null }, what: string): NonNullable<T> {
  const row = must(res, what);
  if (row === null || row === undefined) throw new Error(`supabase ${what}: no row returned`);
  return row;
}

const toUser =(r: Row): User => ({ id: r.id as string, role: r.role as User['role'], displayName: r.display_name as string });
const toConversation = (r: Row): Conversation => ({
  id: r.id as string,
  userId: r.user_id as string,
  status: r.status as Conversation['status'],
  state: ConversationStateSchema.parse(r.state ?? {}),
});
const toMessage = (r: Row): Message => ({
  id: r.id as string,
  conversationId: r.conversation_id as string,
  role: r.role as Message['role'],
  content: r.content as string,
  createdAt: r.created_at as string,
});
const toQuestion = (r: Row): RepQuestion => ({
  id: r.id as string,
  conversationId: r.conversation_id as string,
  missingField: r.missing_field as string,
  questionText: r.question_text as string,
  context: (r.context ?? {}) as RepQuestion['context'],
  answer: (r.answer as string | null) ?? null,
  status: r.status as RepQuestion['status'],
  createdAt: r.created_at as string,
  answeredAt: (r.answered_at as string | null) ?? null,
});

/**
 * Supabase-backed Repo using the service-role key (server only, never sent to the browser).
 * TODO: not exercised against a live Supabase project in this repo's tests; run the migrations and the
 * manual checklist in README before relying on it.
 */
export function createSupabaseRepo(url: string, serviceRoleKey: string): Repo {
  // Same client options as before (service role, no session persistence) plus the Node 20 WebSocket transport.
  const db: SupabaseClient = createAdminClient(url, serviceRoleKey);

  return {
    async getUser(id) {
      const r = must(await db.from('users').select('*').eq('id', id).maybeSingle(), 'getUser');
      return r ? toUser(r) : null;
    },
    async ping() {
      // Harmless read: a head-only count on the small users table. No rows are created and none are returned.
      const { error } = await db.from('users').select('*', { count: 'exact', head: true });
      if (error) throw supabaseFailure('ping', error);
    },
    async createUser(user) {
      // Insert-if-absent: an existing row is never overwritten.
      must(
        await db
          .from('users')
          .upsert({ id: user.id, role: user.role, display_name: user.displayName }, { onConflict: 'id', ignoreDuplicates: true }),
        'createUser',
      );
      const r = must(await db.from('users').select('*').eq('id', user.id).maybeSingle(), 'createUser.read');
      if (!r) throw new Error('supabase createUser: row not found after insert');
      return toUser(r);
    },
    async listUsers() {
      return mustRows(await db.from('users').select('*').order('created_at'), 'listUsers').map(toUser);
    },
    async getProfile(userId) {
      const r = must(await db.from('employee_profiles').select('*').eq('user_id', userId).maybeSingle(), 'getProfile');
      if (!r) return null;
      return {
        userId,
        salaryInputs: SalaryInputsSchema.parse(r.salary_inputs ?? {}),
        groupCode: (r.group_code as ProfileRecord['groupCode']) ?? undefined,
        childrenCount: (r.children_count as number | null) ?? undefined,
        occupation: (r.occupation as string | null) ?? undefined,
      };
    },
    async saveProfile(p) {
      must(
        await db.from('employee_profiles').upsert({
          user_id: p.userId,
          salary_inputs: p.salaryInputs,
          group_code: p.groupCode ?? null,
          children_count: p.childrenCount ?? null,
          occupation: p.occupation ?? null,
          updated_at: new Date().toISOString(),
        }),
        'saveProfile',
      );
    },
    async findConversationByUser(userId) {
      const r = must(
        await db.from('conversations').select('*').eq('user_id', userId).order('created_at').limit(1).maybeSingle(),
        'findConversationByUser',
      );
      return r ? toConversation(r) : null;
    },
    async createConversation(userId, state) {
      const res = await db.from('conversations').insert({ user_id: userId, state }).select('*').single();
      if (res.error?.code === '23505') {
        // unique (user_id), migration 0003: another request created it first, so return that one
        const existing = must(await db.from('conversations').select('*').eq('user_id', userId).maybeSingle(), 'createConversation');
        if (existing) return toConversation(existing);
      }
      return toConversation(mustOne(res, 'createConversation'));
    },
    async getConversation(id) {
      const r = must(await db.from('conversations').select('*').eq('id', id).maybeSingle(), 'getConversation');
      return r ? toConversation(r) : null;
    },
    async saveConversationState(id, state) {
      must(
        await db.from('conversations').update({ state, updated_at: new Date().toISOString() }).eq('id', id),
        'saveConversationState',
      );
    },
    async addMessage(conversationId, role, content) {
      const r = must(
        await db.from('messages').insert({ conversation_id: conversationId, role, content }).select('*').single(),
        'addMessage',
      );
      return toMessage(r);
    },
    async listMessages(conversationId, limit = 200) {
      const rows = mustRows(
        await db.from('messages').select('*').eq('conversation_id', conversationId).order('created_at', { ascending: false }).limit(limit),
        'listMessages',
      );
      return rows.map(toMessage).reverse();
    },
    async createRepQuestion(input) {
      const r = must(
        await db
          .from('rep_questions')
          .insert({
            conversation_id: input.conversationId,
            missing_field: input.missingField,
            question_text: input.questionText,
            context: input.context,
          })
          .select('*')
          .single(),
        'createRepQuestion',
      );
      return toQuestion(r);
    },
    async getRepQuestion(id) {
      const r = must(await db.from('rep_questions').select('*').eq('id', id).maybeSingle(), 'getRepQuestion');
      return r ? toQuestion(r) : null;
    },
    async listRepQuestions(filter) {
      let q = db.from('rep_questions').select('*').order('created_at');
      if (filter?.status) q = q.eq('status', filter.status);
      if (filter?.conversationId) q = q.eq('conversation_id', filter.conversationId);
      return mustRows(await q, 'listRepQuestions').map(toQuestion);
    },
    async updateRepQuestionContext(id, context) {
      const r = must(
        await db.from('rep_questions').update({ context }).eq('id', id).select('*').maybeSingle(),
        'updateRepQuestionContext',
      );
      return r ? toQuestion(r) : null;
    },
    async answerRepQuestion(id, answer) {
      // Conditional update: only an open question can be answered (no overwrite of a previous answer).
      const r = must(
        await db
          .from('rep_questions')
          .update({ answer, status: 'answered', answered_at: new Date().toISOString() })
          .eq('id', id)
          .eq('status', 'open')
          .select('*')
          .maybeSingle(),
        'answerRepQuestion',
      );
      return r ? toQuestion(r) : null;
    },
    async saveCalcResult(rec) {
      const scenario = mustOne(
        await db
          .from('scenarios')
          .insert({ conversation_id: rec.conversationId, type: rec.scenarioType, vehicle_ref: rec.vehicleRef, params: rec.params })
          .select('id')
          .single(),
        'saveScenario',
      );
      must(
        await db.from('calc_results').insert({
          scenario_id: scenario.id,
          inputs_snapshot: rec.inputsSnapshot,
          result: rec.result,
          rules_version: rec.rulesVersion,
          usage_dataset_version: rec.usageDatasetVersion,
        }),
        'saveCalcResult',
      );
    },
  };
}
