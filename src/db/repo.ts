import { resolveRepoMode, type RepoKind } from './repoMode';
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
  /** Creates the user if absent (idempotent); never overwrites an existing row. */
  createUser(user: User): Promise<User>;
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
  /**
   * Replaces the context (jsonb) of a question. Used to keep the server-side workflow of a free-text answer
   * (RepQuestionContext.workflow). Returns the updated question, or null if it does not exist.
   */
  updateRepQuestionContext(id: string, context: RepQuestionContext): Promise<RepQuestion | null>;

  saveCalcResult(rec: CalcRecord): Promise<void>;

  /** Harmless read-only check that the store is reachable. Creates nothing and returns no data. */
  ping(): Promise<void>;
}

export type { RepoKind } from './repoMode';

// The singleton lives on globalThis so it survives dev hot-reloads and is shared between Next's separate bundles
// (instrumentation and route handlers): the startup line is therefore logged once per process.
declare global {
  var __netwiseRepo: Repo | undefined;
  var __netwiseRepoKind: RepoKind | undefined;
  var __netwiseRepoInit: Promise<RepoInfo> | undefined;
}

export interface RepoInfo {
  repo: Repo;
  kind: RepoKind;
}

async function createRepo(): Promise<RepoInfo> {
  const kind = resolveRepoMode(); // throws RepoConfigError: never falls back by accident
  let repo: Repo;
  if (kind === 'supabase') {
    const { createSupabaseRepo } = await import('./supabaseRepo');
    // resolveRepoMode guarantees both variables are set
    repo = createSupabaseRepo(process.env.SUPABASE_URL as string, process.env.SUPABASE_SERVICE_ROLE_KEY as string);
  } else {
    const { createMemoryRepo } = await import('./memoryRepo');
    repo = createMemoryRepo();
  }
  globalThis.__netwiseRepo = repo;
  globalThis.__netwiseRepoKind = kind;
  console.info(`[netwise] repo: ${kind}`); // one line, once per process; never a key or a URL
  return { repo, kind };
}

/**
 * The store in use, chosen by REPO_MODE (see repoMode.ts). Throws RepoConfigError when the configuration is wrong.
 * Concurrent first calls share one creation, so there is exactly one repo and one startup log line.
 */
export async function getRepoInfo(): Promise<RepoInfo> {
  if (globalThis.__netwiseRepo) return { repo: globalThis.__netwiseRepo, kind: globalThis.__netwiseRepoKind ?? 'memory' };
  globalThis.__netwiseRepoInit ??= createRepo().catch((err: unknown) => {
    globalThis.__netwiseRepoInit = undefined; // a failed configuration is not cached
    throw err;
  });
  return globalThis.__netwiseRepoInit;
}

export async function getRepo(): Promise<Repo> {
  return (await getRepoInfo()).repo;
}

/** Test hook: replace the repo singleton (or clear it with undefined). A replaced repo counts as "memory". */
export function setRepo(repo: Repo | undefined, kind: RepoKind = 'memory'): void {
  globalThis.__netwiseRepo = repo;
  globalThis.__netwiseRepoKind = repo ? kind : undefined;
  globalThis.__netwiseRepoInit = undefined;
}
