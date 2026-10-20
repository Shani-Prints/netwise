import { GoogleGenAI } from '@google/genai';
import { fileTypeFromBuffer } from 'file-type';
import { getRepo } from '../db/repo';
import { getSessionSecret, readSession, SessionConfigError } from './session';
import { payslipJsonSchema, payslipSchema } from './payslip-schema';
import { validate } from './payslip-validate';

/**
 * POST /api/payslip/parse. An employee session is required (same cookie as /api/chat), with a per-session rate limit, because
 * every call spends model quota. The files live in memory for this request only. Nothing here logs file content or extracted values.
 */

export const MSG = {
  noSession: 'לא נמצאה הפעלה פעילה. יש לרענן את הדף ולנסות שוב.',
  badSession: 'ההפעלה אינה תקפה. יש לרענן את הדף ולנסות שוב.',
  employeesOnly: 'קריאת תלוש זמינה לעובדים בלבד.',
  rateLimited: 'נשלחו יותר מדי קבצים בזמן קצר. נסו שוב בעוד דקה.',
  notConfigured: 'שירות קריאת התלושים אינו מוגדר כרגע.',
  invalidBody: 'הבקשה אינה תקינה.',
  noFiles: 'לא נבחרו קבצים.',
  tooMany: 'יותר מדי עמודים. ניתן להעלות עד 10 עמודים.',
  tooBig: 'הקבצים גדולים מדי. נסו להעלות תמונות קטנות יותר.',
  badType: 'סוג הקובץ אינו נתמך. ניתן להעלות PDF, JPG, PNG או WebP.',
  busy: 'השירות עמוס כרגע. נסו שוב בעוד דקה.',
  failed: 'קריאת התלוש נכשלה. נסו שוב מאוחר יותר.',
  unreadable: 'לא הצלחנו לקרוא את התלוש. נסו תמונה ברורה יותר או הזינו את הנתונים ידנית.',
  internal: 'אירעה שגיאה. נסו שוב בעוד רגע.',
};

const ALLOWED = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
export const MAX_TOTAL_BYTES = 4.5 * 1024 * 1024; // Vercel request body limit
export const MAX_FILES = 10;
const MODEL_TIMEOUT_MS = 50_000;

const INSTRUCTION =
  'Extract the data from this Israeli payslip according to the schema. All attached files are pages of a single payslip. ' +
  'If a field is not clearly present, return null — do not guess. Numbers only, no currency symbols or thousands separators. ' +
  'Add to lowConfidenceFields any field you were not confident reading.';

export type PayslipPart = { inlineData: { mimeType: string; data: string } } | { text: string };

/** Sends the parts to the model and returns its JSON text. Tests replace it with a mock: no real model call is ever made. */
export type PayslipGenerate = (parts: PayslipPart[], env: Record<string, string | undefined>) => Promise<string | undefined>;

const generateWithGemini: PayslipGenerate = async (parts, env) => {
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY, httpOptions: { timeout: MODEL_TIMEOUT_MS } });
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
  const response = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts }],
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: payslipJsonSchema,
      temperature: 0,
      // "no thinking" is only a 2.5-series setting; other models keep their default
      ...(model.includes('2.5') ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
  });
  return response.text;
};

export interface PayslipDeps {
  env?: Record<string, string | undefined>;
  now?: () => number;
  generate?: PayslipGenerate;
}

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
export function resetPayslipRateLimit(): void {
  hits.clear();
}
function rateLimited(uid: string, now: number, env: Record<string, string | undefined>): boolean {
  const max = Number(env.PAYSLIP_RATE_LIMIT_PER_MIN) > 0 ? Number(env.PAYSLIP_RATE_LIMIT_PER_MIN) : 5;
  if (hits.size > 5000) for (const [k, v] of hits) if (v.every((t) => now - t >= WINDOW_MS)) hits.delete(k);
  const recent = (hits.get(uid) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= max) {
    hits.set(uid, recent);
    return true;
  }
  recent.push(now);
  hits.set(uid, recent);
  return false;
}

export async function handlePayslipParse(req: Request, deps: PayslipDeps = {}): Promise<Response> {
  const env = deps.env ?? process.env;
  try {
    // 1. employee session only (no cookie -> 401)
    const read = readSession(req, getSessionSecret());
    if (read.kind === 'none') return fail(401, MSG.noSession);
    if (read.kind === 'invalid') return fail(401, MSG.badSession);
    if (read.session.role !== 'employee') return fail(403, MSG.employeesOnly);
    if (!(await (await getRepo()).getUser(read.session.uid))) return fail(401, MSG.noSession); // stale cookie

    // 2. rate limit, before anything is read from the body
    if (rateLimited(read.session.uid, (deps.now ?? Date.now)(), env)) return fail(429, MSG.rateLimited);

    if (!env.GEMINI_API_KEY && !deps.generate) return fail(500, MSG.notConfigured);

    // 3. files, in memory only
    const declared = Number(req.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_TOTAL_BYTES + 64 * 1024) return fail(413, MSG.tooBig);
    let files: File[];
    try {
      const form = await req.formData();
      files = form.getAll('files').filter((f): f is File => typeof f !== 'string');
    } catch {
      return fail(400, MSG.invalidBody);
    }
    if (files.length === 0) return fail(400, MSG.noFiles);
    if (files.length > MAX_FILES) return fail(400, MSG.tooMany);
    if (files.reduce((s, f) => s + f.size, 0) > MAX_TOTAL_BYTES) return fail(413, MSG.tooBig);

    const parts: PayslipPart[] = [];
    for (const file of files) {
      const buf = Buffer.from(await file.arrayBuffer());
      const type = await fileTypeFromBuffer(buf); // the real content decides, not the name or the declared type
      if (!type || !ALLOWED.has(type.mime)) return fail(415, MSG.badType);
      parts.push({ inlineData: { mimeType: type.mime, data: buf.toString('base64') } });
    }
    parts.push({ text: INSTRUCTION });

    // 4. the model reads the document; the result is validated by the schema, never trusted as is
    let text: string | undefined;
    try {
      text = await (deps.generate ?? generateWithGemini)(parts, env);
    } catch (e) {
      const status = (e as { status?: number }).status;
      console.error(`[netwise] payslip: model call failed (${status ?? 'no_status'})`); // status only: never content
      return status === 429 ? fail(429, MSG.busy) : fail(502, MSG.failed);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text ?? '');
    } catch {
      return fail(422, MSG.unreadable);
    }
    const parsed = payslipSchema.safeParse(raw);
    if (!parsed.success) return fail(422, MSG.unreadable);

    return json({ data: parsed.data, warnings: validate(parsed.data) });
  } catch (err) {
    if (err instanceof SessionConfigError) console.error('[netwise] payslip: server misconfigured');
    else console.error(`[netwise] payslip: error (${err instanceof Error ? err.name : 'unknown'})`);
    return fail(500, MSG.internal);
  }
}
