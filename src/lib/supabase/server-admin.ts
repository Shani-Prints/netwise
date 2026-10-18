import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

export type AdminClient = SupabaseClient<Database>;

/**
 * Service-role Supabase client. BYPASSES RLS: server code only (service functions, scripts), never client components.
 * The key comes from a non-NEXT_PUBLIC env var, so Next never inlines it into a browser bundle; the guard below
 * is a second line of defence. (The `server-only` package is not used because it also throws under tsx/vitest.)
 */
export function createAdminClient(url: string, serviceRoleKey: string): AdminClient {
  if (typeof window !== 'undefined') throw new Error('server-admin must not be loaded in the browser');
  return createClient<Database>(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

let cached: AdminClient | undefined;

/** Singleton built from SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. */
export function getAdminClient(): AdminClient {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  cached = createAdminClient(url, key);
  return cached;
}
