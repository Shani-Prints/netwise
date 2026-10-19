import { MockLanguageModelV4 } from 'ai/test';
import { vi } from 'vitest';
import { handleChat, type ChatDeps } from '../../src/agent/chatHandler';
import type { ProviderEntry } from '../../src/agent/providers';
import { SESSION_COOKIE } from '../../src/lib/session';
import { BASE, Client, PROFILE, type Json } from '../api/harness';

// Fake models only: no real LLM provider is called anywhere in the tests that import this file.
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const result = (content: unknown[], finish: 'stop' | 'tool-calls') => ({
  content,
  finishReason: { unified: finish, raw: undefined },
  usage,
  warnings: [],
});

let n = 0;
export const call = (toolName: string, input: unknown) =>
  result([{ type: 'tool-call', toolCallId: `f${++n}`, toolName, input: JSON.stringify(input) }], 'tool-calls');
export const say = (text: string) => result([{ type: 'text', text }], 'stop');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const fake = (...responses: any[]) => new MockLanguageModelV4({ doGenerate: responses });
export const provider = (model: MockLanguageModelV4, name = 'fake'): ProviderEntry => ({ name, model });
export const failWith = (make: () => unknown) =>
  new MockLanguageModelV4({
    doGenerate: async () => {
      throw make();
    },
  });

/** No sleeping between retries in tests. */
export const fast = { retries: 2, baseDelayMs: 0, sleep: async () => {} };

export async function chat(c: Client, message: string, deps: ChatDeps = {}) {
  const headers = new Headers({ 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${c.cookie}` });
  const res = await handleChat(new Request(`${BASE}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ message }) }), {
    fallback: fast,
    ...deps,
  });
  return { status: res.status, body: (await res.json()) as Json };
}

/** An anonymous employee with a FULL group ג profile (fictional data), no alternative chosen yet. */
export async function groupGimelEmployee(): Promise<Client> {
  const c = new Client();
  await c.updateProfile(PROFILE);
  return c;
}

/** Captures what the app writes to the console (so tests can assert the exact log lines and that no secret is in them). */
export function captureConsole() {
  const lines = { info: [] as string[], warn: [] as string[], error: [] as string[] };
  const spies = (['info', 'warn', 'error'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines[m].push(a.map(String).join(' '))),
  );
  return {
    lines,
    all: () => [...lines.info, ...lines.warn, ...lines.error],
    restore: () => spies.forEach((s) => s.mockRestore()),
  };
}

export const MESSAGE = 'ומה אם אעבור לטסלה מודל 3?';
/** The engine's Hebrew reason for CAR-14 (group ד) and a group ג employee. */
export const REASON_CAR14 = 'הרכב שייך לקבוצה ד והזכאות שלך היא לקבוצה ג; אפשר לבחור רכב מהקבוצה שלך או מקבוצה נמוכה יותר';
