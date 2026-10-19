import { handleChat, type ChatResponse } from '../agent/chatHandler';
import { handleRepAnswerText } from '../agent/repTextHandlers';
import type { FallbackOptions, ProviderEntry } from '../agent/providers';
import * as H from '../lib/handlers';
import type { Interpreter, InterpretInput } from '../lib/repTextService';
import type { EmployeeStateResponse, RepQuestionView } from '../lib/service';
import { SESSION_COOKIE } from '../lib/session';
import { promptTextOf, recordProviders, stateBlockOf, toolOutputsOf, type RecordedCall } from './recorder';

/**
 * Drives ONE employee conversation through the real HTTP handlers (chat, employee state, representative screen) with whatever
 * repo is installed (the tests and the scenario runner install the in-memory repo). The caller provides the model providers per
 * turn, so the same driver serves scripted fake models and the real model. Needs SESSION_SECRET and REP_ACCESS_CODE in the
 * environment (the caller sets them; nothing here prints them).
 */

const BASE = 'http://localhost:3000';
// the driver sends a few messages per second; the production rate limit (15 per minute) would only get in the way
const DRIVER_ENV = (): Record<string, string | undefined> => ({ ...process.env, CHAT_RATE_LIMIT_PER_MIN: '1000' });

// a representative answer that still waits for its interpretation is retried on the employee turns; by default nothing interprets it
const UNAVAILABLE: Interpreter = async () => ({ status: 'unavailable' });

type Handler = (req: Request) => Promise<Response>;
export type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

class Jar {
  cookie: string | undefined;
  async send(handler: Handler, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
    const headers = new Headers();
    if (this.cookie !== undefined) headers.set('cookie', `${SESSION_COOKIE}=${this.cookie}`);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const res = await handler(new Request(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
    const setCookie = res.headers.get('set-cookie');
    const m = setCookie ? new RegExp(`^${SESSION_COOKIE}=([^;]*)`).exec(setCookie) : null;
    if (m) this.cookie = m[1] === '' ? undefined : m[1];
    return { status: res.status, body: await res.json() };
  }
}

/** What happened in one employee turn: everything the invariants and the expectations need. */
export interface TurnObservation {
  employeeMessage: string;
  status: number;
  assistantText: string;
  response: ChatResponse;
  state: EmployeeStateResponse;
  /** What the representative screen shows for ALL questions of this conversation. */
  repViews: RepQuestionView[];
  stateBlock: string;
  toolOutputs: unknown[];
  /** Plain text of every request the employee-facing model received this turn. */
  promptText: string;
  modelCalls: RecordedCall[];
  /** True when the guard (or an empty answer) replaced the model text with a server text. */
  replaced: boolean;
  replacedVia: string | null;
  replacedReason: string | null;
  latencyMs: number;
  /** Console lines (info/warn/error) written by the app during the turn. They never contain keys or message text. */
  logs: string[];
}

export interface ChatOptions {
  interpret?: Interpreter;
  fallback?: FallbackOptions;
}

export class ConversationDriver {
  private employee = new Jar();
  private rep = new Jar();
  /** Raw representative texts written so far (typed answers and free text), for the "never reaches the employee" checks. */
  readonly repTexts: string[] = [];
  /** Everything the interpreting model received (it must never contain salary values). */
  readonly interpreterInputs: InterpretInput[] = [];

  static async start(): Promise<ConversationDriver> {
    const d = new ConversationDriver();
    const r = await d.employee.send(H.handleGetSession, 'GET', '/api/session');
    if (r.status !== 200) throw new Error(`employee session failed: ${r.status}`);
    const login = await d.rep.send(H.handleRepLogin, 'POST', '/api/session/rep', { code: process.env.REP_ACCESS_CODE ?? '' });
    if (login.status !== 200) throw new Error(`representative login failed: ${login.status}`);
    return d;
  }

  async employeeState(): Promise<EmployeeStateResponse> {
    const r = await this.employee.send(H.handleGetEmployeeState, 'GET', '/api/employee/state');
    if (r.status !== 200) throw new Error(`employee state failed: ${r.status}`);
    return r.body as EmployeeStateResponse;
  }

  async repQuestions(): Promise<RepQuestionView[]> {
    const r = await this.rep.send(H.handleGetRepQuestions, 'GET', '/api/rep/questions');
    if (r.status !== 200) throw new Error(`representative questions failed: ${r.status}`);
    return (r.body as { questions: RepQuestionView[] }).questions;
  }

  /** The employee writes one message; the real chat handler runs with the given providers. */
  async chat(message: string, providers: ProviderEntry[], options: ChatOptions = {}): Promise<TurnObservation> {
    const calls: RecordedCall[] = [];
    const logs: string[] = [];
    const restore = captureLogs(logs);
    const startedAt = Date.now();
    let res: { status: number; body: Json };
    try {
      const headers = new Headers({ 'content-type': 'application/json' });
      if (this.employee.cookie !== undefined) headers.set('cookie', `${SESSION_COOKIE}=${this.employee.cookie}`);
      const response = await handleChat(new Request(`${BASE}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ message }) }), {
        providers: recordProviders(providers, calls),
        interpret: this.recordingInterpreter(options.interpret ?? UNAVAILABLE),
        fallback: options.fallback,
        env: DRIVER_ENV(),
      });
      res = { status: response.status, body: await response.json() };
    } finally {
      restore();
    }
    const latencyMs = Date.now() - startedAt;
    const response = res.body as ChatResponse;
    const state = await this.employeeState();
    const replacedLine = logs.find((l) => l.includes('chat: answer replaced'));
    const m = replacedLine ? /reason=([^,)]*), via=([^,)]*)/.exec(replacedLine) : null;
    return {
      employeeMessage: message,
      status: res.status,
      assistantText: typeof response.assistantText === 'string' ? response.assistantText : '',
      response,
      state,
      repViews: await this.repQuestions(),
      stateBlock: stateBlockOf(calls),
      toolOutputs: toolOutputsOf(calls),
      promptText: promptTextOf(calls),
      modelCalls: calls,
      replaced: replacedLine !== undefined,
      replacedReason: m?.[1] ?? null,
      replacedVia: m?.[2] ?? null,
      latencyMs,
      logs,
    };
  }

  /** The first open question that matches (kind and/or field). Throws when there is none, so a script error is loud. */
  async findOpen(sel: { kind?: string; field?: string }): Promise<RepQuestionView> {
    const open = (await this.repQuestions()).filter((q) => q.status === 'open' && (!sel.kind || q.kind === sel.kind) && (!sel.field || q.field === sel.field));
    if (open.length === 0) throw new Error(`no open representative question for ${JSON.stringify(sel)}`);
    return open[0]!;
  }

  /** The representative answers with the typed API (a number or an option value). */
  async repAnswerTyped(questionId: string, answer: string): Promise<{ status: number; body: Json }> {
    const reply = await this.rep.send(H.handlePostRepAnswer, 'POST', '/api/rep/answer', { questionId, answer });
    // an accepted typed answer is a number or an id from the fixed option list (it may be shown back as the chosen option);
    // a rejected one is arbitrary text and must never surface
    if (reply.status !== 200) this.repTexts.push(answer);
    return reply;
  }

  /** The representative answers in free text; `interpret` is the (fake or real) isolated interpreter. */
  async repAnswerText(questionId: string, text: string, interpret: Interpreter): Promise<{ status: number; body: Json }> {
    this.repTexts.push(text);
    const headers = new Headers({ 'content-type': 'application/json' });
    if (this.rep.cookie !== undefined) headers.set('cookie', `${SESSION_COOKIE}=${this.rep.cookie}`);
    const res = await handleRepAnswerText(new Request(`${BASE}/api/rep/answer-text`, { method: 'POST', headers, body: JSON.stringify({ questionId, text }) }), {
      interpret: this.recordingInterpreter(interpret),
    });
    return { status: res.status, body: await res.json() };
  }

  private recordingInterpreter(inner: Interpreter | undefined): Interpreter | undefined {
    if (!inner) return undefined;
    return async (input) => {
      this.interpreterInputs.push(input);
      return inner(input);
    };
  }
}

/** Collects the app's console output of one turn (and keeps it off the test output). Returns the function that restores the console. */
function captureLogs(sink: string[]): () => void {
  const original = { info: console.info, warn: console.warn, error: console.error };
  for (const level of ['info', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => void sink.push(args.map(String).join(' '));
  }
  return () => Object.assign(console, original);
}
