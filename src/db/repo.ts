import type {
  CalcRecord,
  Conversation,
  ConversationState,
  Message,
  MessageRole,
  ProfileRecord,
  RepQuestion,
  RepQuestionContext,
  User,
} from './types';

/**
 * Persistence port. Two implementations: Supabase (production) and in-memory (local demo / tests).
 * Authorization is NOT done here: callers (src/lib/service.ts) check the session user before every call.
 */
export interface Repo {
  getUser(id: string): Promise<User | null>;
  listUsers(): Promise<User[]>;

  getProfile(userId: string): Promise<ProfileRecord | null>;
  saveProfile(profile: ProfileRecord): Promise<void>;

  findConversationByUser(userId: string): Promise<Conversation | null>;
  createConversation(userId: string, state: ConversationState): Promise<Conversation>;
  getConversation(id: string): Promise<Conversation | null>;
  saveConversationState(id: string, state: ConversationState): Promise<void>;

  addMessage(conversationId: string, role: MessageRole, content: string): Promise<Message>;
  listMessages(conversationId: string, limit?: number): Promise<Message[]>;

  createRepQuestion(input: {
    conversationId: string;
    missingField: string;
    questionText: string;
    context: RepQuestionContext;
  }): Promise<RepQuestion>;
  getRepQuestion(id: string): Promise<RepQuestion | null>;
  listRepQuestions(filter?: { status?: 'open' | 'answered'; conversationId?: string }): Promise<RepQuestion[]>;
  answerRepQuestion(id: string, answer: string): Promise<RepQuestion | null>;

  saveCalcResult(rec: CalcRecord): Promise<void>;
}

declare global {
  var __netwiseRepo: Repo | undefined;
}

/** Supabase when configured, otherwise a process-local in-memory store seeded with the fictional demo users. */
export async function getRepo(): Promise<Repo> {
  if (globalThis.__netwiseRepo) return globalThis.__netwiseRepo;
  let repo: Repo;
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const { createSupabaseRepo } = await import('./supabaseRepo');
    repo = createSupabaseRepo(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  } else {
    const { createMemoryRepo } = await import('./memoryRepo');
    repo = createMemoryRepo();
  }
  globalThis.__netwiseRepo = repo;
  return repo;
}

/** Test hook: replace the repo singleton. */
export function setRepo(repo: Repo | undefined): void {
  globalThis.__netwiseRepo = repo;
}
