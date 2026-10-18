import { randomUUID } from 'node:crypto';
import { createMemoryRepo } from '../../src/db/memoryRepo';
import { setRepo, type Repo } from '../../src/db/repo';
import { createSupabaseRepo } from '../../src/db/supabaseRepo';
import { createAdminClient } from '../../src/lib/supabase/server-admin';
import { demoUsers } from '../../src/lib/demoUsers';
import type { Actor } from '../../src/lib/service';

export interface World {
  A: Actor;
  B: Actor;
  rep: Actor;
  repo: Repo;
  cleanup(): Promise<void>;
}

export const hasSupabase = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

export async function memoryWorld(): Promise<World> {
  const repo = createMemoryRepo();
  setRepo(repo);
  const users = demoUsers();
  const [a, b] = users.filter((u) => u.role === 'employee');
  const rep = users.find((u) => u.role === 'rep')!;
  return {
    A: { userId: a!.id, role: 'employee' },
    B: { userId: b!.id, role: 'employee' },
    rep: { userId: rep.id, role: 'rep' },
    repo,
    cleanup: async () => setRepo(undefined),
  };
}

/** Real dev database. Creates TEST_ users with random ids; cleanup deletes them (FK cascades remove their data). */
export async function supabaseWorld(): Promise<World> {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const db = createAdminClient(url, key);
  const run = randomUUID().slice(0, 8);
  const rows = [
    { id: randomUUID(), role: 'employee', display_name: `TEST_A_${run}` },
    { id: randomUUID(), role: 'employee', display_name: `TEST_B_${run}` },
    { id: randomUUID(), role: 'rep', display_name: `TEST_REP_${run}` },
  ];
  const ids = rows.map((r) => r.id);
  const { error } = await db.from('users').insert(rows);
  if (error) throw new Error(`test setup failed: ${error.message}`);
  const repo = createSupabaseRepo(url, key);
  setRepo(repo);
  return {
    A: { userId: ids[0]!, role: 'employee' },
    B: { userId: ids[1]!, role: 'employee' },
    rep: { userId: ids[2]!, role: 'rep' },
    repo,
    cleanup: async () => {
      setRepo(undefined);
      const { error: delErr } = await db.from('users').delete().in('id', ids);
      if (delErr) throw new Error(`cleanup failed: ${delErr.message}`);
    },
  };
}
