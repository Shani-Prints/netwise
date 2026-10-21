import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryRepo } from '../../src/db/memoryRepo';
import { getRepo, setRepo } from '../../src/db/repo';

afterEach(() => setRepo(undefined));

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });

describe('the 6 sample employees are test data only', () => {
  it('no app source file imports demoUsers (only tests and scripts may)', () => {
    const offenders = walk(path.join(process.cwd(), 'src'))
      .filter((f) => !f.endsWith(`${path.sep}demoUsers.ts`))
      .filter((f) => /\bdemoUsers\b/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the in-memory repo starts EMPTY unless a test passes a seed explicitly', async () => {
    expect(await createMemoryRepo().listUsers()).toEqual([]);
  });

  it('the app\'s default repo has no pre-seeded users', async () => {
    const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      setRepo(undefined);
      expect(await (await getRepo()).listUsers()).toEqual([]);
    } finally {
      if (saved.url !== undefined) process.env.SUPABASE_URL = saved.url;
      if (saved.key !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
    }
  });

  it('no route offers a demo or employee login shortcut', () => {
    const routes = walk(path.join(process.cwd(), 'src', 'app', 'api')).map((f) => path.relative(process.cwd(), f).split(path.sep).join('/'));
    expect(routes.sort()).toEqual([
      'src/app/api/ai-chat/route.ts',
      'src/app/api/chat/route.ts',
      'src/app/api/employee/state/route.ts',
      'src/app/api/health/route.ts',
      'src/app/api/rep/answer-text/route.ts',
      'src/app/api/rep/answer/route.ts',
      'src/app/api/rep/questions/route.ts',
      'src/app/api/session/rep/route.ts',
      'src/app/api/session/route.ts',
    ]);
  });
});
