/**
 * Loads data/usage-value-2026.csv (windows-1255) into public.vehicles with the service role.
 *   pnpm data:load-usage            (reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from .env.local)
 * Idempotent: upserts on the table's unique key, so it can be re-run safely.
 */
import path from 'node:path';
import { readUsageCsv, type UsageRow } from '../src/data/usageCsv';
import { getAdminClient } from '../src/lib/supabase/server-admin';

const BATCH = 1000;
const ATTEMPTS = 4;
const file = process.env.USAGE_CSV_PATH ?? path.join(process.cwd(), 'data', 'usage-value-2026.csv');

const toVehicle = (r: UsageRow) => ({
  tax_year: r.taxYear,
  reg_year: r.registrationYear,
  vehicle_type_code: r.vehicleTypeCode,
  maker_code: r.makerCode,
  model_code: r.modelCode,
  usage_value: r.usageValue,
  maker_name: r.makerName,
  model_description: r.modelDescription,
  commercial_name: r.commercialName,
  drive_code: r.driveCode,
  list_price: r.listPrice,
  source_row: r.rowId,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const db = getAdminClient();
  const rows = readUsageCsv(file);
  const taxYears = [...new Set(rows.map((r) => r.taxYear))];
  console.log(`parsed ${rows.length} rows from ${path.basename(file)} (tax year(s): ${taxYears.join(', ')})`);

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH).map(toVehicle);
    for (let attempt = 1; ; attempt++) {
      const { error } = await db
        .from('vehicles')
        .upsert(batch, { onConflict: 'tax_year,reg_year,vehicle_type_code,maker_code,model_code' });
      if (!error) break;
      console.error(`batch at row ${i} failed (attempt ${attempt}/${ATTEMPTS}): ${error.message}`);
      if (attempt === ATTEMPTS) throw new Error(`giving up at row ${i}`);
      await sleep(1000 * 2 ** (attempt - 1));
    }
    console.log(`upserted ${Math.min(i + BATCH, rows.length)} / ${rows.length}`);
  }

  const { count, error } = await db.from('vehicles').select('*', { count: 'exact', head: true }).in('tax_year', taxYears);
  if (error) throw new Error(`count check failed: ${error.message}`);
  if (count !== rows.length) throw new Error(`row-count mismatch: file has ${rows.length}, table has ${count}`);
  console.log(`OK: vehicles holds ${count} rows for tax year(s) ${taxYears.join(', ')}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
