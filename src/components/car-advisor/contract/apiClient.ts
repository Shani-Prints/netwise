import type { Payslip } from '../../../lib/payslip-schema';
import type { PayslipProfileFields } from '../../../lib/payslip-to-engine';
import { fill } from '../content/fill';
import { he } from '../content/he';
import type {
  ApiAnswerTextResponse,
  ApiChatResponse,
  ApiEmployeeState,
  ApiRepQuestion,
} from './apiTypes';

/** Limits of the server (docs/api-contract.md). The server enforces them too; the client checks first for a friendly message. */
export const MAX_CHAT_CHARS = 1000;
export const MAX_REP_TEXT_CHARS = 500;

/** Where an error happened: it decides the wording of the friendly Hebrew message. */
export type ApiContext = 'session' | 'chat' | 'state' | 'repLogin' | 'repList' | 'repAnswer' | 'repAnswerText';

/** A failed call. `status` 0 means no response at all (network). `serverMessage` is the Hebrew text of a /api/chat error. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly serverMessage: string | null = null,
  ) {
    super(`api_error_${status}_${code}`);
    this.name = 'ApiError';
  }
}

/**
 * Everything the REAL screens call. Identity and role come only from the session cookie (sent automatically, same
 * origin). The client never receives or sends a user id.
 */
export interface AdvisorApiClient {
  /** GET /api/session, once. Must happen before the first chat message. Safe to call many times. */
  ensureSession(): Promise<void>;
  /** POST /api/chat. On a 401 the session is renewed and the message is sent once more. */
  sendMessage(message: string): Promise<ApiChatResponse>;
  /** POST /api/payslip/parse with the prepared files (pages of one payslip). Nothing is stored by the server. */
  parsePayslip(files: File[]): Promise<{ data: Payslip; warnings: string[] }>;
  /** POST /api/employee/state (update_profile, source "payslip"): saves the confirmed payslip values. */
  confirmPayslip(fields: PayslipProfileFields): Promise<void>;
  /** POST /api/chat { event: "payslip_confirmed" }: the bot continues by itself (no user bubble). */
  sendPayslipConfirmed(): Promise<ApiChatResponse>;
  /** GET /api/employee/state (messages, comparison, questions). On a 401 the session is renewed and it is read once more. */
  getState(): Promise<ApiEmployeeState>;
  /** POST /api/session/rep. The code is only sent, never stored or logged. */
  repLogin(code: string): Promise<void>;
  repListQuestions(): Promise<ApiRepQuestion[]>;
  repAnswerTyped(questionId: string, answer: string): Promise<ApiRepQuestion>;
  repAnswerText(questionId: string, text: string): Promise<ApiAnswerTextResponse>;
}

export interface ApiClientOptions {
  /** Defaults to the global fetch. Tests pass a mock. */
  fetch?: typeof fetch;
  /** Prefix of every path. Same origin by default. */
  baseUrl?: string;
}

export function createApiClient(options: ApiClientOptions = {}): AdvisorApiClient {
  const base = options.baseUrl ?? '';
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ApiError(0, 'network');
    }
    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) throw toApiError(response.status, data);
    return data as T;
  }

  // ---- the session: once before the first chat message, again after a 401 ----
  async function startSession(): Promise<void> {
    try {
      await call('GET', '/api/session');
    } catch (error) {
      // a cookie that cannot be verified (401) is cleared, then a new anonymous session is created
      if (error instanceof ApiError && error.status === 401) {
        await call('DELETE', '/api/session');
        await call('GET', '/api/session');
      } else {
        throw error;
      }
    }
  }
  let sessionReady: Promise<void> | null = null;
  const ensureSession = (): Promise<void> => {
    sessionReady ??= startSession().catch((error: unknown) => {
      sessionReady = null; // a failed start is tried again next time
      throw error;
    });
    return sessionReady;
  };
  const renewSession = (): Promise<void> => {
    sessionReady = null;
    return ensureSession();
  };

  /** Runs `attempt` once; on a 401 the session is renewed and it runs exactly one more time. */
  async function withSessionRetry<T>(attempt: () => Promise<T>): Promise<T> {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      await renewSession();
      return attempt();
    }
  }

  return {
    ensureSession,

    async sendMessage(message) {
      const text = message.trim();
      if (text === '') throw new ApiError(400, 'empty_message');
      if (text.length > MAX_CHAT_CHARS) throw new ApiError(400, 'too_long');
      await ensureSession();
      return withSessionRetry(() => call<ApiChatResponse>('POST', '/api/chat', { message: text }));
    },

    async parsePayslip(files) {
      await ensureSession();
      const send = async () => {
        const form = new FormData();
        files.forEach((f) => form.append('files', f));
        let response: Response;
        try {
          response = await doFetch(`${base}/api/payslip/parse`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', body: form });
        } catch {
          throw new ApiError(0, 'network');
        }
        const data: unknown = await response.json().catch(() => null);
        if (!response.ok) throw toApiError(response.status, data);
        return data as { data: Payslip; warnings: string[] };
      };
      return withSessionRetry(send);
    },

    async confirmPayslip(fields) {
      await ensureSession();
      await withSessionRetry(() => call('POST', '/api/employee/state', { action: 'update_profile', fields, source: 'payslip' }));
    },

    async sendPayslipConfirmed() {
      await ensureSession();
      return withSessionRetry(() => call<ApiChatResponse>('POST', '/api/chat', { event: 'payslip_confirmed' }));
    },

    async getState() {
      await ensureSession();
      return withSessionRetry(() => call<ApiEmployeeState>('GET', '/api/employee/state'));
    },

    async repLogin(code) {
      await call('POST', '/api/session/rep', { code });
      sessionReady = null; // the cookie now belongs to a representative
    },

    async repListQuestions() {
      const body = await call<{ questions: ApiRepQuestion[] }>('GET', '/api/rep/questions');
      return body.questions;
    },

    async repAnswerTyped(questionId, answer) {
      const body = await call<{ question: ApiRepQuestion }>('POST', '/api/rep/answer', { questionId, answer });
      return body.question;
    },

    async repAnswerText(questionId, text) {
      const trimmed = text.trim();
      if (trimmed === '') throw new ApiError(400, 'empty_message');
      if (trimmed.length > MAX_REP_TEXT_CHARS) throw new ApiError(400, 'too_long');
      return call<ApiAnswerTextResponse>('POST', '/api/rep/answer-text', { questionId, text: trimmed });
    },
  };
}

/** `{ error: "<Hebrew>" }` (chat) or `{ error: { code } }` (everything else). */
function toApiError(status: number, data: unknown): ApiError {
  const error = (data as { error?: unknown } | null)?.error;
  if (typeof error === 'string') return new ApiError(status, 'server_message', error);
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return new ApiError(status, typeof code === 'string' ? code : 'unknown');
}

/** A short, friendly Hebrew sentence for any failure. Never includes a stack, a status number or server internals. */
export function describeApiError(error: unknown, context: ApiContext): string {
  const e = he.api.errors;
  if (!(error instanceof ApiError)) return e.generic;
  const { status, code, serverMessage } = error;
  if (status === 0) return e.network;
  if (code === 'too_long') return fill(e.tooLong, { max: String(context === 'repAnswerText' ? MAX_REP_TEXT_CHARS : MAX_CHAT_CHARS) });
  if (code === 'empty_message') return e.invalid;
  if (context === 'repLogin') {
    if (status === 401) return e.wrongCode;
    if (status === 403) return e.loginDisabled;
    if (status === 429) return e.rateLimited;
    return status === 400 ? e.invalid : e.generic;
  }
  switch (status) {
    case 400:
      if (code === 'invalid_answer') return e.invalidAnswer;
      return context === 'chat' && serverMessage ? serverMessage : e.invalid;
    case 401:
      return context === 'chat' || context === 'state' || context === 'session' ? e.session : e.needLogin;
    case 403:
      return context === 'chat' || context === 'state' ? e.forbidden : e.notRep;
    case 404:
      return e.notFound;
    case 409:
      return e.conflict;
    case 429:
      return e.rateLimited;
    case 503:
      return serverMessage ?? e.busy;
    default:
      return e.generic;
  }
}
