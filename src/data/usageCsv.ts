import fs from 'node:fs';

/** One row of the official usage-value (שווי שימוש) dataset, trimmed and typed. */
export interface UsageRow {
  /** 1-based position among data rows of the source CSV; stable for a given file, used as the "dataset row id". */
  rowId: number;
  taxYear: number;
  registrationYear: number;
  vehicleTypeCode: string;
  makerCode: string;
  makerName: string;
  modelCode: string;
  modelDescription: string;
  fuelType: string;
  commercialName: string;
  automatic: number;
  /** Raw value of the "1-חשמלי.2-היברידי.3-פלג-אין" column (see README: legend vs rules file disagree). */
  driveCode: number;
  greenScore: number;
  pollutionLevel: number;
  engineVolume: number;
  weight: number;
  effectiveDate: string;
  listPrice: number;
  adjustedPrice: number;
  usageValue: number;
}

export const USAGE_CSV_COLUMNS = 19;

/**
 * Splits one line on commas. The official file is NOT quoted CSV: a bare " is ordinary text (e.g. ארה"ב), so quote
 * handling would corrupt rows. The strict per-row column count in parseUsageCsv guards this assumption.
 */
export function splitCsvLine(line: string): string[] {
  return line.split(',');
}

const num = (s: string, what: string, rowId: number): number => {
  const n = Number(s);
  if (s === '' || !Number.isFinite(n)) throw new Error(`usage CSV row ${rowId}: bad number for ${what}: "${s}"`);
  return n;
};

/** Decodes the windows-1255 file and parses every row. Throws on any malformed row (no silent skipping). */
export function parseUsageCsv(buf: Uint8Array): UsageRow[] {
  const text = new TextDecoder('windows-1255').decode(buf).replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = splitCsvLine(lines[0] ?? '');
  if (header.length !== USAGE_CSV_COLUMNS) {
    throw new Error(`usage CSV: expected ${USAGE_CSV_COLUMNS} columns, header has ${header.length}`);
  }
  const rows: UsageRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i] ?? '').map((x) => x.trim());
    const rowId = i;
    if (f.length !== USAGE_CSV_COLUMNS) throw new Error(`usage CSV row ${rowId}: ${f.length} columns`);
    rows.push({
      rowId,
      taxYear: num(f[0]!, 'taxYear', rowId),
      registrationYear: num(f[1]!, 'registrationYear', rowId),
      vehicleTypeCode: f[2]!,
      makerCode: f[3]!,
      makerName: f[4]!,
      modelCode: f[5]!,
      modelDescription: f[6]!,
      fuelType: f[7]!,
      commercialName: f[8]!,
      automatic: num(f[9]!, 'automatic', rowId),
      driveCode: num(f[10]!, 'driveCode', rowId),
      greenScore: num(f[11]!, 'greenScore', rowId),
      pollutionLevel: num(f[12]!, 'pollutionLevel', rowId),
      engineVolume: num(f[13]!, 'engineVolume', rowId),
      weight: num(f[14]!, 'weight', rowId),
      effectiveDate: f[15]!,
      listPrice: num(f[16]!, 'listPrice', rowId),
      adjustedPrice: num(f[17]!, 'adjustedPrice', rowId),
      usageValue: num(f[18]!, 'usageValue', rowId),
    });
  }
  return rows;
}

export function readUsageCsv(file: string): UsageRow[] {
  return parseUsageCsv(fs.readFileSync(file));
}
