import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRepo, getRepoInfo, setRepo } from '../../src/db/repo';
import { RepoConfigError, resolveRepoMode } from '../../src/db/repoMode';
import { register } from '../../src/instrumentation';

// Everything here is offline: nothing connects to Supabase (constructing a client opens no connection).
// The URL and key are fake and deliberately recognisable, so a leak into any output is detectable.
const URL = 'https://leak-check-project.supabase.co';
const KEY = 'leak-check-service-role-key-0123456789';
const BOTH = { SUPABASE_URL: URL, SUPABASE_SERVICE_ROLE_KEY: KEY };
const LEAK = /leak-check/;

describe('resolveRepoMode (pure function of the environment)', () => {
  it('REPO_MODE=supabase with a missing variable throws and names only the variable, never a value', () => {
    for (const env of [
      { REPO_MODE: 'supabase' },
      { REPO_MODE: 'supabase', SUPABASE_URL: URL },
      { REPO_MODE: 'supabase', SUPABASE_SERVICE_ROLE_KEY: KEY },
      { REPO_MODE: 'supabase', SUPABASE_URL: '   ', SUPABASE_SERVICE_ROLE_KEY: KEY },
      { REPO_MODE: 'supabase', NODE_ENV: 'development' },
    ]) {
      expect(() => resolveRepoMode(env), JSON.stringify(Object.keys(env))).toThrow(RepoConfigError);
      try {
        resolveRepoMode(env);
      } catch (e) {
        expect((e as Error).message).toMatch(/never falls back/);
        expect((e as Error).message).not.toMatch(LEAK);
      }
    }
    expect(() => resolveRepoMode({ REPO_MODE: 'supabase', SUPABASE_URL: URL })).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(() => resolveRepoMode({ REPO_MODE: 'supabase', SUPABASE_SERVICE_ROLE_KEY: KEY })).toThrow(/SUPABASE_URL/);
  });

  it('REPO_MODE=supabase with both variables selects Supabase, in any environment', () => {
    for (const NODE_ENV of ['development', 'production', 'test']) {
      expect(resolveRepoMode({ REPO_MODE: 'supabase', NODE_ENV, ...BOTH })).toBe('supabase');
    }
  });

  it('REPO_MODE=memory is explicit: memory in every environment, even with Supabase variables present', () => {
    for (const NODE_ENV of ['development', 'production', 'test']) {
      expect(resolveRepoMode({ REPO_MODE: 'memory', NODE_ENV })).toBe('memory');
      expect(resolveRepoMode({ REPO_MODE: 'memory', NODE_ENV, ...BOTH })).toBe('memory');
    }
  });

  it('auto in production WITHOUT variables throws (no silent memory) and explains how to opt in', () => {
    for (const REPO_MODE of [undefined, '', 'auto', ' AUTO ']) {
      const env = { REPO_MODE, NODE_ENV: 'production' };
      expect(() => resolveRepoMode(env), String(REPO_MODE)).toThrow(RepoConfigError);
      expect(() => resolveRepoMode(env)).toThrow(/REPO_MODE=memory explicitly/);
    }
    // one variable is not enough either
    expect(() => resolveRepoMode({ NODE_ENV: 'production', SUPABASE_URL: URL })).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(() => resolveRepoMode({ NODE_ENV: 'production', SUPABASE_SERVICE_ROLE_KEY: KEY })).toThrow(/SUPABASE_URL/);
    expect(() => resolveRepoMode({ NODE_ENV: 'production' })).not.toThrow(/leak-check/);
  });

  it('auto in production WITH both variables selects Supabase; with explicit memory it is allowed', () => {
    expect(resolveRepoMode({ NODE_ENV: 'production', ...BOTH })).toBe('supabase');
    expect(resolveRepoMode({ NODE_ENV: 'production', REPO_MODE: 'memory' })).toBe('memory');
  });

  it('auto in development with both variables selects Supabase; without them it uses memory', () => {
    expect(resolveRepoMode({ NODE_ENV: 'development', ...BOTH })).toBe('supabase');
    expect(resolveRepoMode({ NODE_ENV: 'development', REPO_MODE: 'auto', ...BOTH })).toBe('supabase');
    expect(resolveRepoMode({ NODE_ENV: 'development' })).toBe('memory');
    expect(resolveRepoMode({ NODE_ENV: 'test' })).toBe('memory');
    expect(resolveRepoMode({})).toBe('memory');
  });

  it('the default is auto, the value is case/space-insensitive, and an unknown value throws', () => {
    expect(resolveRepoMode({ REPO_MODE: '' })).toBe('memory');
    expect(resolveRepoMode({ REPO_MODE: ' Memory ' })).toBe('memory');
    expect(resolveRepoMode({ REPO_MODE: 'SUPABASE', ...BOTH })).toBe('supabase');
    for (const bad of ['sqlite', 'true', 'mem', 'supabase,memory']) {
      expect(() => resolveRepoMode({ REPO_MODE: bad }), bad).toThrow(RepoConfigError);
    }
  });
});

describe('getRepo: the store is chosen by REPO_MODE and announced exactly once', () => {
  let out: string[];

  const env = (vars: Record<string, string>) => {
    for (const [k, v] of Object.entries({ REPO_MODE: '', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', NODE_ENV: 'test', ...vars })) {
      vi.stubEnv(k, v);
    }
  };
  const startupLines = () => out.filter((l) => l.startsWith('[netwise] repo:'));

  beforeEach(() => {
    setRepo(undefined);
    out = [];
    for (const m of ['info', 'log', 'warn', 'error'] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void out.push(args.map(String).join(' ')));
    }
  });
  afterEach(() => {
    setRepo(undefined);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('REPO_MODE=memory is explicit and starts EMPTY', async () => {
    env({ REPO_MODE: 'memory', ...BOTH });
    const info = await getRepoInfo();
    expect(info.kind).toBe('memory');
    expect(await info.repo.listUsers()).toEqual([]);
  });

  it('REPO_MODE=supabase with a missing variable rejects, never falls back, and is not cached', async () => {
    env({ REPO_MODE: 'supabase', SUPABASE_URL: URL });
    await expect(getRepoInfo()).rejects.toThrow(RepoConfigError);
    await expect(getRepo()).rejects.toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(globalThis.__netwiseRepo).toBeUndefined();
    expect(startupLines()).toEqual([]);
    env({ REPO_MODE: 'supabase', ...BOTH }); // fixing the configuration works on the next call
    expect((await getRepoInfo()).kind).toBe('supabase');
  });

  it('auto in production without variables rejects', async () => {
    env({ NODE_ENV: 'production' });
    await expect(getRepo()).rejects.toThrow(/REPO_MODE=memory explicitly/);
    expect(globalThis.__netwiseRepo).toBeUndefined();
  });

  it('auto in production with REPO_MODE=memory set explicitly is allowed', async () => {
    env({ NODE_ENV: 'production', REPO_MODE: 'memory' });
    expect((await getRepoInfo()).kind).toBe('memory');
  });

  it('auto in development with both variables selects Supabase (offline: nothing is called)', async () => {
    env({ NODE_ENV: 'development', ...BOTH });
    const info = await getRepoInfo();
    expect(info.kind).toBe('supabase');
    expect(typeof info.repo.ping).toBe('function');
  });

  it('logs ONE line per process, even for concurrent first calls and later calls', async () => {
    env({ REPO_MODE: 'memory' });
    await Promise.all([getRepo(), getRepo(), getRepo(), getRepoInfo()]);
    await getRepo();
    expect(startupLines()).toEqual(['[netwise] repo: memory']);
  });

  it('the Supabase line contains no key, no URL and no project name, and nothing else leaks to any console', async () => {
    env({ REPO_MODE: 'supabase', ...BOTH });
    await getRepo();
    await getRepo();
    expect(startupLines()).toEqual(['[netwise] repo: supabase']);
    expect(out.join('\n')).not.toMatch(LEAK);
    expect(out.join('\n')).not.toMatch(/supabase\.co|https?:\/\//);
  });

  it('a repo injected with setRepo is reported as memory and is not announced', async () => {
    const fake = (await (async () => {
      env({ REPO_MODE: 'memory' });
      return getRepo();
    })()) as never;
    out.length = 0;
    setRepo(fake);
    expect((await getRepoInfo()).kind).toBe('memory');
    expect(startupLines()).toEqual([]);
  });
});

describe('src/instrumentation.ts register(): decides the store at server start', () => {
  let out: string[];
  const env = (vars: Record<string, string>) => {
    for (const [k, v] of Object.entries({ REPO_MODE: '', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', NODE_ENV: 'test', NEXT_RUNTIME: 'nodejs', NEXT_PHASE: '', SESSION_SECRET: 'test-secret-0123456789', GEMINI_API_KEY: '', GROQ_API_KEY: '', OPENROUTER_API_KEY: '', ...vars })) {
      vi.stubEnv(k, v);
    }
  };

  beforeEach(() => {
    setRepo(undefined);
    out = [];
    vi.spyOn(console, 'info').mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(' ')));
  });
  afterEach(() => {
    setRepo(undefined);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('creates the store and logs the single startup line', async () => {
    env({ REPO_MODE: 'memory' });
    await register();
    await register();
    expect(out).toEqual(['[netwise] repo: memory']);
  });

  it('throws on a wrong configuration, so the server does not start', async () => {
    env({ NODE_ENV: 'production' });
    await expect(register()).rejects.toThrow(RepoConfigError);
    env({ REPO_MODE: 'supabase', SUPABASE_URL: URL });
    await expect(register()).rejects.toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(out).toEqual([]);
  });

  it('throws a clear error naming SESSION_SECRET when it is missing, before touching the store', async () => {
    env({ REPO_MODE: 'memory', SESSION_SECRET: '' });
    await expect(register()).rejects.toThrow(/SESSION_SECRET/);
    expect(out).toEqual([]);
  });

  it('does nothing during `next build` (configuration is a runtime concern) and outside the Node.js runtime', async () => {
    env({ NODE_ENV: 'production', NEXT_PHASE: 'phase-production-build' });
    await expect(register()).resolves.toBeUndefined();
    env({ NODE_ENV: 'production', NEXT_RUNTIME: 'edge' });
    await expect(register()).resolves.toBeUndefined();
    expect(globalThis.__netwiseRepo).toBeUndefined();
    expect(out).toEqual([]);
  });
});
