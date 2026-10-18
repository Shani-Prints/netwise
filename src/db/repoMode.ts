/**
 * Which store the app uses is a deliberate, checkable decision, never an accident.
 *
 *   REPO_MODE=supabase  requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY; throws if either is missing and NEVER falls
 *                       back to the in-memory store.
 *   REPO_MODE=memory    the in-memory store, explicitly (data is lost on restart). Allowed in any environment.
 *   REPO_MODE=auto      (default, also when empty) Supabase when both variables exist, otherwise memory, EXCEPT in
 *                       production (NODE_ENV=production) where it throws instead of silently using memory. In
 *                       production, memory must be requested explicitly with REPO_MODE=memory.
 *
 * Pure function of the environment: no network, no side effects, so it is fully testable offline.
 * Error messages name variables only; they never include a value (no keys, no URLs).
 */

export type RepoKind = 'supabase' | 'memory';

export class RepoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoConfigError';
  }
}

const MODES = ['supabase', 'memory', 'auto'] as const;
const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;

const isSet = (v: string | undefined) => v !== undefined && v.trim() !== '';

export function resolveRepoMode(env: Record<string, string | undefined> = process.env): RepoKind {
  const raw = (env.REPO_MODE ?? '').trim().toLowerCase();
  const mode = raw === '' ? 'auto' : raw;
  if (!(MODES as readonly string[]).includes(mode)) {
    // REPO_MODE is not a secret, so echoing a (shortened) typo helps; the other variables are never echoed.
    throw new RepoConfigError(`REPO_MODE must be "supabase", "memory" or "auto" (or empty = auto); got "${raw.slice(0, 24)}"`);
  }
  if (mode === 'memory') return 'memory';

  const missing = REQUIRED.filter((name) => !isSet(env[name]));
  if (mode === 'supabase') {
    if (missing.length > 0) {
      throw new RepoConfigError(
        `REPO_MODE=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY; missing: ${missing.join(', ')}. ` +
          'It never falls back to the in-memory store.',
      );
    }
    return 'supabase';
  }

  // auto
  if (missing.length === 0) return 'supabase';
  if (env.NODE_ENV === 'production') {
    throw new RepoConfigError(
      `REPO_MODE=auto in production needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY; missing: ${missing.join(', ')}. ` +
        'It will not silently use the in-memory store (data would be lost on restart). ' +
        'Set the Supabase variables, or set REPO_MODE=memory explicitly if the in-memory store is really intended.',
    );
  }
  return 'memory';
}
