/** Verifies the Supabase connection and prints row counts. Prints no secrets.   pnpm db:check */
import { getAdminClient } from '../src/db/adminClient';

async function main() {
  const db = getAdminClient();
  for (const table of ['vehicles', 'users'] as const) {
    const { count, error } = await db.from(table).select('*', { count: 'exact', head: true });
    if (error) throw new Error(`public.${table}: ${error.message}`);
    console.log(`public.${table}: ${count} rows`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
