/**
 * Runs once when a Next.js server instance starts, before it serves requests (Next 16 `instrumentation` convention).
 * It chooses the store (REPO_MODE) and logs the single startup line "[netwise] repo: supabase|memory".
 * A wrong configuration (for example production with no Supabase variables and no explicit REPO_MODE=memory, or no
 * SESSION_SECRET) throws HERE, so the server fails to start with a message that names the variable (never a value).
 * A missing LLM key is only a warning: the app still serves everything except the model-backed answers.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return; // the edge runtime has no Node APIs and no store
  // Store configuration is a runtime concern: do not break `next build` (CI may build before the variables exist).
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  const { getSessionSecret } = await import('./lib/session');
  getSessionSecret(); // throws SessionConfigError naming SESSION_SECRET when it is missing or too short
  const { getRepo } = await import('./db/repo');
  await getRepo();
  const { buildProviders } = await import('./agent/providers');
  if (buildProviders(process.env).length === 0) {
    console.warn('[netwise] no LLM provider key is set (GEMINI_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY): /api/chat will answer 503');
  }
}
