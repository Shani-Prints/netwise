import { convertToModelMessages, type UIMessage } from 'ai';
import { BUSY_MESSAGE_HE } from '@/agent/providers';
import { AllProvidersFailedError, limitHistory, readConfig, streamWithFallback } from '@/lib/ai/fallback';
import { describeError } from '@/lib/errorLog';
import { getSessionSecret, readSession } from '@/lib/session';

/**
 * POST /api/ai-chat: a plain streaming chat with automatic provider + API-key fallback (see src/lib/ai/).
 * Body: { messages: UIMessage[] } (what `useChat` sends). Response: the AI SDK UI message stream.
 *
 * Separate from /api/chat, which is the tool-calling advisor agent.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const SYSTEM_PROMPT = 'You are a helpful assistant. Answer briefly and in the language of the user.';
const MAX_BODY_BYTES = 100_000;

const text = (body: string, status: number) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

export async function POST(req: Request): Promise<Response> {
  // An LLM endpoint without auth is a free quota drain for anyone who finds the URL.
  const read = readSession(req, getSessionSecret());
  if (read.kind !== 'ok') return text('Session required. Refresh the page and try again.', 401);

  let messages: UIMessage[];
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return text('Request too large.', 413);
    const body = JSON.parse(raw) as { messages?: unknown };
    if (!Array.isArray(body.messages) || body.messages.length === 0) return text('Invalid request.', 400);
    messages = body.messages as UIMessage[];
  } catch {
    return text('Invalid request.', 400);
  }

  try {
    // Token saving: trim BEFORE converting, so we never convert history we will not send.
    const recent = limitHistory(messages, readConfig().maxHistoryMessages);
    const modelMessages = await convertToModelMessages(recent);

    // Resolves only once a provider has really started streaming, so a fallback never produces a cut-off answer.
    const { result } = await streamWithFallback({ messages: modelMessages, system: SYSTEM_PROMPT, abortSignal: req.signal });

    return result.toUIMessageStreamResponse({
      // A failure AFTER the first token cannot be retried on another provider (the user already saw text); say so politely.
      onError: (err) => {
        console.error(`[ai] mid-stream failure: ${describeError(err)}`);
        return BUSY_MESSAGE_HE;
      },
    });
  } catch (err) {
    if (err instanceof AllProvidersFailedError) return text(BUSY_MESSAGE_HE, 503);
    console.error(`[ai] /api/ai-chat failed: ${describeError(err)}`);
    return text(BUSY_MESSAGE_HE, 500);
  }
}
