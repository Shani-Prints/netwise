import { generateText, stepCountIs, type ModelMessage } from 'ai';
import type { Repo } from '../db/repo';
import { participationFromRepresentative } from '../lib/flags';
import { prepareEmployeeTurn, type Actor, type TurnContext } from '../lib/service';
import { guardResponse, type GuardReason } from './guard';
import { buildStateBlock, buildSystemPrompt } from './prompt';
import { withFallback, type FallbackOptions, type ProviderEntry } from './providers';
import { newCollector, createTools, type TurnCollector } from './tools';

const HISTORY_LIMIT = 20;
const MAX_STEPS = 8;
const CALL_TIMEOUT_MS = 45_000;

export const NEUTRAL_FALLBACK_HE = 'לא הצלחתי לנסח תשובה מדויקת. אפשר לנסח את השאלה מחדש או לספר לי מה חסר לך?';

export interface AgentTurnArgs {
  repo: Repo;
  actor: Actor;
  conversationId: string;
  /** Context prepared at the start of the turn (representative answers already applied). */
  context: TurnContext;
  providers: ProviderEntry[];
  showProvisional: boolean;
  /** PARTICIPATION_FROM_REPRESENTATIVE. Default: read the env flag (false). Selects the prompt policy. */
  participationFromRepresentative?: boolean;
  fallback?: FallbackOptions;
}

export interface AgentTurnResult {
  assistantText: string;
  collector: TurnCollector;
  context: TurnContext;
  provider: string;
  /** Set when the guard replaced the model text with the deterministic explanation. */
  guardReason?: GuardReason | 'empty';
}

/** Deterministic Hebrew text built only from tool results (which come from src/lib/explain.ts). */
export function deterministicText(collector: TurnCollector): string {
  if (collector.lastView) return collector.lastView.explanation.join('\n');
  for (const r of [...collector.results].reverse()) {
    const o = r.output as { missingText?: string[]; text?: string; status?: string } | null;
    if (o?.missingText && o.missingText.length > 0) return `חסר לי מידע כדי להמשיך: ${o.missingText.join(', ')}.`;
    if (r.tool === 'check_eligibility' && o?.text) return `${o.text}.`;
  }
  return NEUTRAL_FALLBACK_HE;
}

async function history(repo: Repo, conversationId: string): Promise<ModelMessage[]> {
  const all = (await repo.listMessages(conversationId)).slice(-HISTORY_LIMIT);
  const msgs: ModelMessage[] = all.map((m) =>
    m.role === 'user'
      ? { role: 'user', content: m.content }
      : { role: 'assistant', content: m.role === 'system' ? `[הודעת מערכת] ${m.content}` : m.content },
  );
  while (msgs[0] && msgs[0].role !== 'user') msgs.shift();
  return msgs;
}

/** One employee turn: model + tools with provider fallback, then the response guard. Throws AllProvidersFailedError. */
export async function runAgentTurn(args: AgentTurnArgs): Promise<AgentTurnResult> {
  const { repo, actor, conversationId, providers, showProvisional } = args;
  const fromRep = args.participationFromRepresentative ?? participationFromRepresentative();
  let first = true;

  const { value, provider } = await withFallback(
    providers,
    async (p) => {
      // A retry starts from freshly saved state (an earlier attempt may already have saved data).
      const ctx: TurnContext = first
        ? args.context
        : { ...(await prepareEmployeeTurn(repo, actor)), updates: args.context.updates };
      first = false;
      const collector = newCollector();
      const stateBlock = buildStateBlock(ctx, showProvisional);
      const result = await generateText({
        model: p.model,
        instructions: buildSystemPrompt(stateBlock, fromRep),
        messages: await history(repo, conversationId),
        tools: createTools({ repo, actor, collector, showProvisional, participationFromRepresentative: fromRep }),
        stopWhen: stepCountIs(MAX_STEPS),
        maxRetries: 0, // retries and backoff are handled by withFallback
        temperature: 0.2,
        timeout: CALL_TIMEOUT_MS,
      });
      return { text: result.text, collector, ctx, stateBlock };
    },
    args.fallback,
  );

  const text = value.text.trim();
  let assistantText = text;
  let guardReason: AgentTurnResult['guardReason'];
  if (text === '') {
    guardReason = 'empty';
    assistantText = deterministicText(value.collector);
  } else {
    const g = guardResponse(text, value.collector, [value.stateBlock]);
    if (!g.ok) {
      guardReason = g.reason;
      assistantText = deterministicText(value.collector);
    }
  }
  return { assistantText, collector: value.collector, context: value.ctx, provider, guardReason };
}
