import path from 'node:path';
import { readUsageCsv, type UsageRow } from './usageCsv';

const stripZeros = (s: string) => s.replace(/^0+(?=\d)/, '');

const fullKey = (taxYear: number, reg: number, type: string, maker: string, model: string) =>
  [taxYear, reg, stripZeros(type), stripZeros(maker), stripZeros(model)].join('|');
const vehicleKey = (reg: number, maker: string, model: string) => [reg, stripZeros(maker), stripZeros(model)].join('|');

export interface UsageIndex {
  rows: UsageRow[];
  byKey: Map<string, UsageRow>;
  byVehicle: Map<string, UsageRow[]>;
  taxYear: number;
  /** Identifies which dataset produced a result (stored with every calculation). */
  datasetVersion: string;
}

export function buildUsageIndex(rows: UsageRow[]): UsageIndex {
  const byKey = new Map<string, UsageRow>();
  const byVehicle = new Map<string, UsageRow[]>();
  let taxYear = 0;
  for (const r of rows) {
    taxYear = Math.max(taxYear, r.taxYear);
    const k = fullKey(r.taxYear, r.registrationYear, r.vehicleTypeCode, r.makerCode, r.modelCode);
    if (byKey.has(k)) throw new Error(`usage dataset: duplicate key ${k}`);
    byKey.set(k, r);
    const vk = vehicleKey(r.registrationYear, r.makerCode, r.modelCode);
    const list = byVehicle.get(vk);
    if (list) list.push(r);
    else byVehicle.set(vk, [r]);
  }
  return { rows, byKey, byVehicle, taxYear, datasetVersion: `usage-value-${taxYear}/${rows.length}` };
}

let cached: UsageIndex | undefined;

/** Lazily loads the official CSV into an indexed in-memory map (default source for local dev and the demo). */
export function getUsageIndex(
  file = process.env.USAGE_CSV_PATH ?? path.join(process.env.NETWISE_DATA_DIR ?? path.join(process.cwd(), 'data'), 'usage-value-2026.csv'),
): UsageIndex {
  cached ??= buildUsageIndex(readUsageCsv(file));
  return cached;
}

export interface UsageQuery {
  taxYear?: number;
  registrationYear: number;
  makerCode: string;
  modelCode: string;
  /** Required to disambiguate when several vehicle types exist for the same maker/model/year. */
  vehicleTypeCode?: string;
}

export type UsageLookup =
  | { status: 'found'; row: UsageRow; datasetRowId: number }
  | { status: 'not_found' }
  | { status: 'ambiguous'; candidates: UsageRow[] };

/** Exact lookup on (tax year, registration year, vehicle type, maker, model). Never guesses between candidates. */
export function lookupUsageValue(index: UsageIndex, q: UsageQuery): UsageLookup {
  const taxYear = q.taxYear ?? index.taxYear;
  if (q.vehicleTypeCode !== undefined) {
    const row = index.byKey.get(fullKey(taxYear, q.registrationYear, q.vehicleTypeCode, q.makerCode, q.modelCode));
    return row ? { status: 'found', row, datasetRowId: row.rowId } : { status: 'not_found' };
  }
  const candidates = (index.byVehicle.get(vehicleKey(q.registrationYear, q.makerCode, q.modelCode)) ?? []).filter(
    (r) => r.taxYear === taxYear,
  );
  if (candidates.length === 0) return { status: 'not_found' };
  if (candidates.length > 1) return { status: 'ambiguous', candidates };
  return { status: 'found', row: candidates[0]!, datasetRowId: candidates[0]!.rowId };
}

/** Free-text search by maker and/or model name (so an employee can say "טויוטה קורולה 2022"). Max `limit` rows. */
export function searchVehicles(
  index: UsageIndex,
  q: { maker?: string; model?: string; registrationYear?: number },
  limit = 12,
): UsageRow[] {
  const maker = q.maker?.trim().toLowerCase();
  const model = q.model?.trim().toLowerCase();
  if (!maker && !model) return [];
  const out: UsageRow[] = [];
  for (const r of index.rows) {
    if (q.registrationYear !== undefined && r.registrationYear !== q.registrationYear) continue;
    if (maker && !r.makerName.toLowerCase().includes(maker)) continue;
    if (model && !r.commercialName.toLowerCase().includes(model) && !r.modelDescription.toLowerCase().includes(model)) continue;
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}
