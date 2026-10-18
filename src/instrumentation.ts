/**
 * Runs once when a Next.js server instance starts, before it serves requests (Next 16 `instrumentation` convention).
 * It chooses the store (REPO_MODE) and logs the single startup line "[netwise] repo: supabase|memory".
 * A wrong configuration (for example production with no Supabase variables and no explicit REPO_MODE=memory) throws
 * HERE, so the server fails to start instead of quietly keeping data in memory.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return; // the edge runtime has no Node APIs and no store
  // Store configuration is a runtime concern: do not break `next build` (CI may build before the variables exist).
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  const { getRepo } = await import('./db/repo');
  await getRepo();
}
