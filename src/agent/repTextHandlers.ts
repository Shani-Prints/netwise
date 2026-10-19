import { z } from 'zod';
import { getRepo } from '../db/repo';
import { authenticate, handleGetRepQuestions, json, parseBody, run } from '../lib/handlers';
import { retryPendingInterpretations, submitRepText, type Interpreter } from '../lib/repTextService';
import { ServiceError } from '../lib/service';
import { createInterpreter } from './interpretRepText';
import { buildProviders, type ProviderEntry } from './providers';

/**
 * POST /api/rep/answer-text and the representative screen's questions list (which also retries answers that are still waiting
 * for their interpretation). The interpretation never makes either of them fail: a model problem leaves the answer pending.
 */

export const REP_TEXT_MAX_CHARS = 500;

export interface RepTextDeps {
  /** Tests inject a fake interpreter; production builds one from the configured providers. */
  interpret?: Interpreter;
  /** Alternatively: providers for the real isolated interpreter (tests pass a fake model here). */
  providers?: ProviderEntry[];
  env?: Record<string, string | undefined>;
  now?: () => number;
}

const AnswerTextBodySchema = z.object({
  questionId: z.string().min(1).max(100),
  text: z.string().min(1).max(REP_TEXT_MAX_CHARS),
});

// ---- per-representative rate limit (in memory, per server process) ----
const hits = new Map<string, number[]>();
const WINDOW_MS = 60_000;
export function resetRepTextRateLimit(): void {
  hits.clear();
}
function limited(uid: string, now: number, env: Record<string, string | undefined>): boolean {
  const max = Number(env.REP_TEXT_RATE_LIMIT_PER_MIN) > 0 ? Number(env.REP_TEXT_RATE_LIMIT_PER_MIN) : 30;
  const recent = (hits.get(uid) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= max) {
    hits.set(uid, recent);
    return true;
  }
  recent.push(now);
  hits.set(uid, recent);
  return false;
}

const interpreterFor = (deps: RepTextDeps): Interpreter => deps.interpret ?? createInterpreter(deps.providers ?? buildProviders(deps.env ?? process.env));

export const handleRepAnswerText = (req: Request, deps: RepTextDeps = {}) =>
  run(async () => {
    const a = await authenticate(req, 'rep');
    if (limited(a.actor.userId, (deps.now ?? Date.now)(), deps.env ?? process.env)) throw new ServiceError(429, 'rate_limited');
    const body = await parseBody(req, AnswerTextBodySchema);
    const reply = await submitRepText(await getRepo(), a.actor, body, { interpret: interpreterFor(deps), now: deps.now });
    return json(reply);
  });

export const handleRepQuestionsWithRetry = (req: Request, deps: RepTextDeps = {}) =>
  run(async () => {
    await authenticate(req, 'rep');
    try {
      await retryPendingInterpretations(await getRepo(), { interpret: interpreterFor(deps), now: deps.now });
    } catch (err) {
      console.error(`[netwise] rep screen: retry of pending answers failed (${err instanceof Error ? err.name : 'unknown'})`);
    }
    return handleGetRepQuestions(req);
  });
