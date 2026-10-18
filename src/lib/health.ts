import { getRepoInfo, type Repo, type RepoKind } from '../db/repo';
import { RepoConfigError } from '../db/repoMode';

/**
 * GET /api/health. Public (no session cookie) and read-only. The body is ALWAYS exactly { repo, ok }:
 *   - repo: which store is in use ("supabase" | "memory"), or null when the configuration is invalid (no store chosen)
 *   - ok:   whether a harmless read (repo.ping(): a head-only count, creates nothing) succeeded
 * Nothing else is revealed: no URLs, no keys, no counts, no user data, no error text.
 */
export interface HealthDeps {
  /** Tests inject a fake store here (no network). Default: the app's real store. */
  getRepoInfo?: () => Promise<{ repo: Pick<Repo, 'ping'>; kind: RepoKind }>;
}

function json(body: { repo: RepoKind | null; ok: boolean }, status: number): Response {
  return new Response(JSON.stringify({ repo: body.repo, ok: body.ok }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function handleHealth(deps: HealthDeps = {}): Promise<Response> {
  let kind: RepoKind | null = null;
  try {
    const info = await (deps.getRepoInfo ?? getRepoInfo)();
    kind = info.kind;
    await info.repo.ping();
    return json({ repo: kind, ok: true }, 200);
  } catch (err) {
    // Server log only. A RepoConfigError message names variables, never values; other errors log just their type.
    console.error(
      `[netwise] health check failed: ${err instanceof RepoConfigError ? err.message : err instanceof Error ? err.name : 'unknown'}`,
    );
    return json({ repo: kind, ok: false }, 503);
  }
}
