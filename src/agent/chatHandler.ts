import { z } from 'zod';
import { getRepo } from '../db/repo';
import { participationFromRepresentative } from '../lib/flags';
import { flushEscalations, getEmployeeState, recordComparison, ServiceError, type EmployeeQuestionView } from '../lib/service';
import { describeError } from '../lib/errorLog';
import { getSessionSecret, readSession, SessionConfigError } from '../lib/session';
import type { ComparisonView } from '../lib/view';
import { retryPendingInterpretations, type Interpreter } from '../lib/repTextService';
import { runAgentTurn } from './agent';
import { buildCarChoices, type CarChoices } from './carChoices';
import { applyStatedZeros } from './statedZeros';
import { createInterpreter } from './interpretRepText';
import { prepareTurnWithCurrentCar } from './currentCar';
import { applyProvisionalPolicy, showProvisionalAlternative } from './provisional';
import { AllProvidersFailedError, BUSY_MESSAGE_HE, buildProviders, type FallbackOptions, type ProviderEntry } from './providers';

/** POST /api/chat. Contract with the UI: see ChatResponse. All error bodies are { error: "<Hebrew message>" }. */

export const MAX_MESSAGE_CHARS = 1000;
const MAX_BODY_BYTES = 20_000;

export interface ChatResponse {
  assistantText: string;
  comparison?: ComparisonView;
  pendingQuestions?: EmployeeQuestionView[];
  updates?: { newAnswers: boolean };
  /** The cars to pick by clicking (built by the server). Present only while the bot waits for the car to compare / the current car. */
  carChoices?: CarChoices;
}

const ChatBodySchema = z.union([
  z.object({ message: z.string().trim().min(1) }),
  z.object({ event: z.literal('payslip_confirmed') }),
]);

/** Fixed server text for the model after a payslip was confirmed. Not typed by the employee, never stored or displayed. */
export const PAYSLIP_CONFIRMED_INSTRUCTION =
  '[SYSTEM EVENT - not written by the employee] The employee just confirmed a payslip and the server saved its values (see fromConfirmedPayslip and "saved" in SERVER STATE). ' +
  'Thank them in one short sentence and say what was filled from the payslip in a few words. Do not ask for anything listed in fromConfirmedPayslip. ' +
  'Then ask ONLY for what is still missing (askNext), together in one short message; if nothing is missing, ask which car or waiver to compare and ask it in ONE short sentence: the server shows the cars as buttons, never list the cars yourself. Never ask for the car to compare together with other questions.';

export const MSG = {
  invalidBody: 'הבקשה אינה תקינה. יש לשלוח הודעת טקסט.',
  tooLong: `ההודעה ארוכה מדי. אפשר לכתוב עד ${MAX_MESSAGE_CHARS} תווים.`,
  noSession: 'לא נמצאה הפעלה פעילה. יש לרענן את הדף ולנסות שוב.',
  badSession: 'ההפעלה אינה תקפה. יש לרענן את הדף ולנסות שוב.',
  employeesOnly: 'הצ׳אט זמין לעובדים בלבד.',
  rateLimited: 'נשלחו יותר מדי הודעות בזמן קצר. נסו שוב בעוד דקה.',
  internal: 'אירעה שגיאה. נסו שוב בעוד רגע.',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
const fail = (status: number, error: string) => json({ error }, status);

// ---- simple in-memory rate limit per session (per server process) ----
const hits = new Map<string, number[]>();
const WINDOW_MS = 60_000;
export function resetChatRateLimit(): void {
  hits.clear();
}
function rateLimited(uid: string, now: number, env: Record<string, string | undefined>): boolean {
  const max = Number(env.CHAT_RATE_LIMIT_PER_MIN) > 0 ? Number(env.CHAT_RATE_LIMIT_PER_MIN) : 15;
  if (hits.size > 5000) for (const [k, v] of hits) if (v.every((t) => now - t >= WINDOW_MS)) hits.delete(k); // bounded memory in a long-lived instance
  const recent = (hits.get(uid) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= max) {
    hits.set(uid, recent);
    return true;
  }
  recent.push(now);
  hits.set(uid, recent);
  return false;
}

export interface ChatDeps {
  /** Tests inject fake models here; production builds them from env. */
  providers?: ProviderEntry[];
  fallback?: FallbackOptions;
  /** The isolated interpretation of representative free text (tests inject a fake one). */
  interpret?: Interpreter;
  now?: () => number;
  env?: Record<string, string | undefined>;
  /** Tests shorten the deadline. Default: CHAT_DEADLINE_MS. */
  deadlineMs?: number;
}

/**
 * The route has maxDuration = 60. Slow providers (up to 45 s per call, then the next provider) could outlive it, and the platform
 * would answer with its own non-JSON 504. Answering the fixed Hebrew busy message first keeps the contract; the next call works as
 * usual (the employee message is already saved).
 */
export const CHAT_DEADLINE_MS = 55_000;

export async function handleChat(req: Request, deps: ChatDeps = {}): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Response>((resolve) => {
    timer = setTimeout(() => {
      console.error('[netwise] chat: deadline_exceeded');
      resolve(fail(503, BUSY_MESSAGE_HE));
    }, deps.deadlineMs ?? CHAT_DEADLINE_MS);
  });
  try {
    return await Promise.race([handleChatTurn(req, deps), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function handleChatTurn(req: Request, deps: ChatDeps): Promise<Response> {
  const env = deps.env ?? process.env;
  try {
    // 1. employee session only (no cookie -> 401; the app creates the session via GET /api/session or /api/employee/state)
    const read = readSession(req, getSessionSecret());
    if (read.kind === 'none') return fail(401, MSG.noSession);
    if (read.kind === 'invalid') return fail(401, MSG.badSession);
    if (read.session.role !== 'employee') return fail(403, MSG.employeesOnly);
    const actor = { userId: read.session.uid, role: 'employee' as const };

    // 2. rate limit
    if (rateLimited(actor.userId, (deps.now ?? Date.now)(), env)) return fail(429, MSG.rateLimited);

    // 3. body
    if (!(req.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
      return fail(400, MSG.invalidBody);
    }
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return fail(400, MSG.tooLong);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return fail(400, MSG.invalidBody);
    }
    const body = ChatBodySchema.safeParse(raw);
    if (!body.success) return fail(400, MSG.invalidBody);
    const isPayslipEvent = 'event' in body.data;
    const message = 'message' in body.data ? body.data.message : '';
    if (message.length > MAX_MESSAGE_CHARS) return fail(400, MSG.tooLong);

    // 4. start of the turn: representative answers already applied are in context
    const repo = await getRepo();
    if (!(await repo.getUser(actor.userId))) return fail(401, MSG.noSession); // stale cookie: nothing is created or read for it
    const conv = await repo.findConversationByUser(actor.userId);
    if (!conv) throw new ServiceError(500, 'no_conversation');

    const providers = deps.providers ?? buildProviders(env);
    if (providers.length === 0) {
      console.error('[netwise] chat: no_provider_configured'); // no key set for any provider in LLM_PROVIDER_ORDER
      return fail(503, BUSY_MESSAGE_HE);
    }

    // The event is only valid after a confirmed payslip was saved; otherwise nothing happens (no model call, no message).
    if (isPayslipEvent && (conv.state.payslipFields ?? []).length === 0) return json({ assistantText: '' } satisfies ChatResponse);

    if (!isPayslipEvent) await repo.addMessage(conv.id, 'user', message); // saved first: never lost if every provider fails
    // Representative answers that are still waiting for their interpretation (row 11/12) are retried on every employee turn.
    // Nothing here can fail the turn, and nothing about it is shown to the employee until it is interpreted.
    try {
      await retryPendingInterpretations(repo, { interpret: deps.interpret ?? createInterpreter(providers) }, { conversationId: conv.id, limit: 2 });
    } catch (err) {
      console.error(`[netwise] chat: retry of pending representative answers failed (${err instanceof Error ? err.name : 'unknown'})`);
    }
    // "אין לי X" for a field that is still missing is a stated zero: recorded here, never asked again ("is it 0%?")
    try {
      if (!isPayslipEvent) await applyStatedZeros(repo, actor, conv.id, message);
    } catch (err) {
      console.error(`[netwise] chat: recording stated zeros failed (${err instanceof Error ? err.name : 'unknown'})`);
    }
    // start of the turn: rep answers applied, and a current car the employee named is resolved on the server
    const context = await prepareTurnWithCurrentCar(repo, actor, isPayslipEvent ? '' : message);

    const show = showProvisionalAlternative(env);
    let turn;
    try {
      turn = await runAgentTurn({
        repo,
        actor,
        conversationId: conv.id,
        context,
        providers,
        showProvisional: show,
        participationFromRepresentative: participationFromRepresentative(env),
        carIssues: context.carIssues,
        openedAtStart: context.openedAtStart,
        userMessage: isPayslipEvent ? undefined : message,
        transientInstruction: isPayslipEvent ? PAYSLIP_CONFIRMED_INSTRUCTION : undefined,
        fallback: deps.fallback,
      });
    } catch (err) {
      if (err instanceof AllProvidersFailedError) return fail(503, BUSY_MESSAGE_HE);
      throw err;
    }
    // The reference prompt was shown in an earlier turn and the model did not finish it: the server opens the questions now.
    if (context.pendingAtStart > 0) await flushEscalations(repo, actor);
    const botMessage = await repo.addMessage(conv.id, 'assistant', turn.assistantText);

    // 5. response per the contract
    const state = await getEmployeeState(repo, actor);
    const open = state.questions.filter((q) => q.status === 'open');
    const out: ChatResponse = { assistantText: turn.assistantText };
    if ((turn.collector.lastView || context.updates.newAnswers) && state.comparison) {
      out.comparison = applyProvisionalPolicy(state.comparison, show);
    }
    // a comparison calculated in this turn stays in the conversation at THIS bot message (the engine result of the turn)
    if (turn.collector.lastView && out.comparison?.status === 'ok') await recordComparison(repo, actor, botMessage.id, out.comparison);
    if (open.length > 0) out.pendingQuestions = open;
    if (context.updates.newAnswers) out.updates = { newAnswers: true };
    const carChoices = await buildCarChoices(repo, actor);
    if (carChoices) out.carChoices = carChoices;
    return json(out);
  } catch (err) {
    if (err instanceof SessionConfigError) console.error('[netwise] chat: server misconfigured');
    else console.error(`[netwise] chat error: ${describeError(err)}`);
    return fail(500, MSG.internal);
  }
}
