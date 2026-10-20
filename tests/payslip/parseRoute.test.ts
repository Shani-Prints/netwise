import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handlePayslipParse, MSG, MAX_FILES, resetPayslipRateLimit, type PayslipGenerate } from '../../src/lib/payslipParse';
import { SESSION_COOKIE } from '../../src/lib/session';
import { BASE, Client, freshRepo, restoreEnv, setupEnv } from '../api/harness';
import { fictionalPayslip } from './helpers';

// Mock model only: no real Gemini call is made anywhere in this file.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');

function formWith(files: { name: string; type: string; data: Buffer }[]): FormData {
  const form = new FormData();
  for (const f of files) form.append('files', new File([new Uint8Array(f.data)], f.name, { type: f.type }));
  return form;
}
const png = { name: 'page.png', type: 'image/png', data: PNG };

function request(cookie: string | undefined, body: FormData | string | undefined, headers: Record<string, string> = {}): Request {
  const h = new Headers(headers);
  if (cookie !== undefined) h.set('cookie', `${SESSION_COOKIE}=${cookie}`);
  return new Request(`${BASE}/api/payslip/parse`, { method: 'POST', headers: h, body });
}

const ok = (payload: unknown = fictionalPayslip()): PayslipGenerate => vi.fn(async () => JSON.stringify(payload));
const env = { GEMINI_API_KEY: 'test-key-not-real' };

let employee: Client;
beforeEach(async () => {
  setupEnv();
  freshRepo();
  resetPayslipRateLimit();
  employee = new Client();
  await employee.session();
});
afterEach(() => restoreEnv());

describe('POST /api/payslip/parse', () => {
  it('no session -> 401 and the model is never called', async () => {
    const generate = ok();
    const res = await handlePayslipParse(request(undefined, formWith([png])), { env, generate });
    expect(res.status).toBe(401);
    expect(generate).not.toHaveBeenCalled();
  });

  it('a forged session cookie -> 401', async () => {
    const generate = ok();
    const res = await handlePayslipParse(request('forged.value', formWith([png])), { env, generate });
    expect(res.status).toBe(401);
    expect(generate).not.toHaveBeenCalled();
  });

  it('a representative session -> 403', async () => {
    const rep = new Client();
    await rep.repLogin('rep-code-for-tests');
    const generate = ok();
    const res = await handlePayslipParse(request(rep.cookie, formWith([png])), { env, generate });
    expect(res.status).toBe(403);
    expect(generate).not.toHaveBeenCalled();
  });

  it('success: returns the validated payslip and the warnings', async () => {
    const generate = ok();
    const res = await handlePayslipParse(
      request(employee.cookie, formWith([png, { name: 'p.pdf', type: 'application/pdf', data: PDF }])),
      { env, generate },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.grossSalary).toBe(20000);
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    const parts = (generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { inlineData?: { mimeType: string } }[];
    expect(parts.filter((p) => p.inlineData).map((p) => p.inlineData!.mimeType)).toEqual(['image/png', 'application/pdf']);
  });

  it('a file whose content is not a PDF / image -> 415 (the declared type is not trusted)', async () => {
    const generate = ok();
    const res = await handlePayslipParse(
      request(employee.cookie, formWith([{ name: 'fake.png', type: 'image/png', data: Buffer.from('this is plain text, not a picture') }])),
      { env, generate },
    );
    expect(res.status).toBe(415);
    expect(generate).not.toHaveBeenCalled();
  });

  it('too many files -> 400', async () => {
    const generate = ok();
    const res = await handlePayslipParse(request(employee.cookie, formWith(Array.from({ length: MAX_FILES + 1 }, () => png))), { env, generate });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(MSG.tooMany);
    expect(generate).not.toHaveBeenCalled();
  });

  it('no files / not a form -> 400', async () => {
    const generate = ok();
    expect((await handlePayslipParse(request(employee.cookie, formWith([])), { env, generate })).status).toBe(400);
    expect((await handlePayslipParse(request(employee.cookie, 'not a form', { 'content-type': 'text/plain' }), { env, generate })).status).toBe(400);
  });

  it('files above the total size limit -> 413', async () => {
    const generate = ok();
    const big = { name: 'big.pdf', type: 'application/pdf', data: Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]) };
    const res = await handlePayslipParse(request(employee.cookie, formWith([big])), { env, generate });
    expect(res.status).toBe(413);
    expect(generate).not.toHaveBeenCalled();
  });

  it('the model returns text that is not JSON -> 422', async () => {
    const res = await handlePayslipParse(request(employee.cookie, formWith([png])), { env, generate: async () => 'not json at all' });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe(MSG.unreadable);
  });

  it('the model returns JSON that does not match the schema -> 422', async () => {
    const res = await handlePayslipParse(request(employee.cookie, formWith([png])), { env, generate: ok({ grossSalary: 'x' }) });
    expect(res.status).toBe(422);
  });

  it('the model fails -> 502, 429 from the model -> 429, and nothing from the failure is logged', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')));
    try {
      const r502 = await handlePayslipParse(request(employee.cookie, formWith([png])), {
        env,
        generate: async () => {
          throw new Error('boom 20000 secret-looking content');
        },
      });
      expect(r502.status).toBe(502);
      const r429 = await handlePayslipParse(request(employee.cookie, formWith([png])), {
        env,
        generate: async () => {
          throw Object.assign(new Error('quota'), { status: 429 });
        },
      });
      expect(r429.status).toBe(429);
    } finally {
      spy.mockRestore();
    }
    expect(logged.join('\n')).not.toMatch(/boom|20000|secret-looking/);
  });

  it('per-session rate limit -> 429 after the limit; other sessions are not affected', async () => {
    const generate = ok();
    const deps = { env: { ...env, PAYSLIP_RATE_LIMIT_PER_MIN: '2' }, generate, now: () => 1_000_000 };
    expect((await handlePayslipParse(request(employee.cookie, formWith([png])), deps)).status).toBe(200);
    expect((await handlePayslipParse(request(employee.cookie, formWith([png])), deps)).status).toBe(200);
    const limited = await handlePayslipParse(request(employee.cookie, formWith([png])), deps);
    expect(limited.status).toBe(429);
    expect(generate).toHaveBeenCalledTimes(2);
    const other = new Client();
    await other.session();
    expect((await handlePayslipParse(request(other.cookie, formWith([png])), deps)).status).toBe(200);
  });

  it('no model key configured (and no injected model) -> 500 with a Hebrew message', async () => {
    const res = await handlePayslipParse(request(employee.cookie, formWith([png])), { env: {} });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe(MSG.notConfigured);
  });
});
