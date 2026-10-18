import { createClient, type RealtimeClientOptions, type SupabaseClient } from '@supabase/supabase-js';
import ws from 'ws';

/**
 * Service-role Supabase client for server code and scripts (db:check, db:seed, data:load-usage) and for the app's
 * Supabase repository. BYPASSES RLS: never import it from a client component. The key comes from a non-NEXT_PUBLIC env
 * var, so Next never inlines it into a browser bundle; the guard below is a second line of defence. (The `server-only`
 * package is not used because it also throws under tsx / vitest.)
 *
 * Imported from origin/restructure's src/lib/supabase/server-admin.ts, placed here (src/db) instead of src/lib so
 * nothing under src/lib is copied from that branch. Untyped on purpose: restructure's generated Database types are
 * not imported.
 */
export type AdminClient = SupabaseClient;

/**
 * supabase-js builds its realtime client when the client is created, and realtime-js needs a WebSocket constructor
 * right then, even if realtime is never used. Node 22+ has a global WebSocket; Node 20 does not, and without a
 * `transport` realtime-js throws "Node.js detected but native WebSocket not found" (realtime-js declares
 * engines node >= 22 and documents `transport` for exactly this: "Supply a compatible implementation (native
 * WebSocket, `ws`, etc) when running outside the browser").
 *
 * So: use the native WebSocket when it exists (pass nothing), otherwise supply the `ws` package.
 * Exported for tests; `has` lets a test simulate either Node version.
 */
export function realtimeTransportOptions(
  has: boolean = typeof globalThis.WebSocket !== 'undefined',
): Pick<RealtimeClientOptions, 'transport'> {
  return has ? {} : { transport: ws as unknown as NonNullable<RealtimeClientOptions['transport']> };
}

export function createAdminClient(url: string, serviceRoleKey: string): AdminClient {
  if (typeof window !== 'undefined') throw new Error('adminClient must not be loaded in the browser');
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: realtimeTransportOptions(),
  });
}

let cached: AdminClient | undefined;

/** Singleton built from SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Throws (without printing values) if either is missing. */
export function getAdminClient(): AdminClient {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see .env.local)');
  cached = createAdminClient(url, key);
  return cached;
}
