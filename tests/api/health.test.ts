import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../../src/app/api/health/route';
import { createMemoryRepo } from '../../src/db/memoryRepo';
import { setRepo } from '../../src/db/repo';
import { RepoConfigError } from '../../src/db/repoMode';
import { handleHealth } from '../../src/lib/health';
import { restoreEnv, setupEnv } from './harness';

const SECRET_TEXT = 'leak-check-service-role-key-0123456789 https://leak-check-project.supabase.co';
let errors: string[];

beforeEach(() => {
  setRepo(createMemoryRepo(), 'memory');
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')));
});
afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv();
  setRepo(undefined);
});

const body = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe('GET /api/health', () => {
  it('memory store: 200 with exactly { repo, ok } and nothing else', async () => {
    const res = await handleHealth();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"repo":"memory","ok":true}');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('is public: works with no cookie and even when SESSION_SECRET is not configured', async () => {
    setupEnv({ secret: null, repCode: null });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ repo: 'memory', ok: true });
  });

  it('a Supabase-labelled store reports repo "supabase" after its harmless read (fake store, no network)', async () => {
    const ping = vi.fn(async () => undefined);
    const res = await handleHealth({ getRepoInfo: async () => ({ repo: { ping }, kind: 'supabase' }) });
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ repo: 'supabase', ok: true });
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('a failing read gives 503 { repo, ok:false } and no error text, key or URL in the body or the log', async () => {
    const res = await handleHealth({
      getRepoInfo: async () => ({
        repo: {
          ping: async () => {
            throw new Error(`supabase ping failed: ${SECRET_TEXT}`);
          },
        },
        kind: 'supabase',
      }),
    });
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('{"repo":"supabase","ok":false}');
    expect(errors.join('\n')).not.toMatch(/leak-check|supabase\.co/);
  });

  it('a wrong configuration gives 503 { repo:null, ok:false } (no store could be chosen) and no message', async () => {
    const res = await handleHealth({
      getRepoInfo: async () => {
        throw new RepoConfigError('REPO_MODE=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY; missing: SUPABASE_URL.');
      },
    });
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('{"repo":null,"ok":false}');
    expect(errors.join('\n')).toMatch(/missing: SUPABASE_URL/); // the operator sees the variable NAME in the server log
  });

  it('reveals no user data even when the store holds some', async () => {
    const repo = createMemoryRepo();
    setRepo(repo, 'memory');
    await repo.createUser({ id: 'user-id-should-not-leak', role: 'employee', displayName: 'Name-should-not-leak' });
    const text = await (await handleHealth()).text();
    expect(text).toBe('{"repo":"memory","ok":true}');
    expect(text).not.toMatch(/should-not-leak/);
  });

  it('the memory store\'s ping creates nothing', async () => {
    const repo = createMemoryRepo();
    setRepo(repo, 'memory');
    await handleHealth();
    expect(await repo.listUsers()).toEqual([]);
    expect(await repo.listRepQuestions()).toEqual([]);
  });
});
