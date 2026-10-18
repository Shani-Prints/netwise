/**
 * Seeds one fictional employee, one fictional rep, their public.users rows and the employee's profile
 * (with sample salary_inputs). Idempotent: fixed ids + upserts. Fictional demo data only.
 *   pnpm db:seed
 */
import { demoProfiles, demoUsers } from '../src/lib/demoUsers';
import { getAdminClient } from '../src/db/adminClient';

async function main() {
  const db = getAdminClient();
  const users = demoUsers();
  const employee = users.find((u) => u.role === 'employee');
  const rep = users.find((u) => u.role === 'rep');
  const profile = demoProfiles().find((p) => p.userId === employee?.id);
  if (!employee || !rep || !profile) throw new Error('demo identities missing from src/lib/demoUsers.ts');

  const { error: uErr } = await db
    .from('users')
    .upsert([employee, rep].map((u) => ({ id: u.id, role: u.role, display_name: u.displayName })), { onConflict: 'id' });
  if (uErr) throw new Error(`users upsert failed: ${uErr.message}`);

  const { error: pErr } = await db.from('employee_profiles').upsert(
    {
      user_id: profile.userId,
      salary_inputs: profile.salaryInputs,
      group_code: profile.groupCode ?? null,
      children_count: profile.childrenCount ?? null,
      occupation: profile.occupation ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
  if (pErr) throw new Error(`profile upsert failed: ${pErr.message}`);

  console.log(`seeded employee ${employee.id} (${employee.displayName}) and rep ${rep.id} (${rep.displayName})`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
