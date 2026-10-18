import { describe, expect, it } from 'vitest';
import { loadCatalog, loadOccupations, loadSampleEmployees, toCarSpec } from '../../src/data/catalog';
import { lookupUsageValue, searchVehicles } from '../../src/data/usageValues';
import { rules, usage } from '../helpers';

describe('usage-value dataset', () => {
  it('has 77,988 rows with unique keys (index construction throws on duplicates)', () => {
    expect(usage.rows).toHaveLength(77988);
    expect(usage.byKey.size).toBe(77988);
    expect(usage.datasetVersion).toBe('usage-value-2026/77988');
  });
  it('is trimmed and decoded from cp1255 (no padding, Hebrew intact)', () => {
    for (const r of usage.rows.slice(0, 2000)) {
      expect(r.makerName).toBe(r.makerName.trim());
      expect(r.commercialName).toBe(r.commercialName.trim());
    }
    expect(usage.rows[0]!.makerName).toBe('אאודי');
  });
});

describe('catalogue usage values', () => {
  const catalog = loadCatalog();
  it('has 18 regular cars + 2 family-track cars', () => {
    expect(catalog).toHaveLength(20);
    expect(catalog.filter((c) => c.group === 'family').map((c) => c.id)).toEqual(['CAR-19', 'CAR-20']);
  });
  for (const c of catalog) {
    it(`${c.id} ${c.modelName}: dataset value equals the catalogue value`, () => {
      const hit = lookupUsageValue(usage, {
        registrationYear: c.registrationYear,
        makerCode: c.makerCode,
        modelCode: c.modelCode,
        vehicleTypeCode: c.vehicleTypeCode,
      });
      expect(hit.status).toBe('found');
      if (hit.status === 'found') {
        expect(hit.row.usageValue).toBe(c.usageValue);
        expect(typeof hit.datasetRowId).toBe('number');
      }
      expect(toCarSpec(c, usage).usageValue).toBe(c.usageValue);
    });
  }
  it('CAR-10 (BYD Atto 3) is ambiguous without a vehicle type and resolves to type 1 = 3,130', () => {
    const c = catalog.find((x) => x.id === 'CAR-10')!;
    const q = { registrationYear: c.registrationYear, makerCode: c.makerCode, modelCode: c.modelCode };
    const amb = lookupUsageValue(usage, q);
    expect(amb.status).toBe('ambiguous');
    if (amb.status === 'ambiguous') expect(amb.candidates.map((r) => r.usageValue).sort()).toEqual([3130, 6950]);
    expect(c.vehicleTypeCode).toBe('1');
    expect(lookupUsageValue(usage, { ...q, vehicleTypeCode: '2' })).toMatchObject({
      status: 'found',
      row: { usageValue: 6950 },
    });
  });
  it('reports not_found for an unknown vehicle (never a guessed value)', () => {
    expect(lookupUsageValue(usage, { registrationYear: 2025, makerCode: '99999', modelCode: '99999' }).status).toBe(
      'not_found',
    );
  });
  it('free-text search finds vehicles by maker and model', () => {
    const rows = searchVehicles(usage, { maker: 'קיה', model: 'picanto', registrationYear: 2025 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.registrationYear === 2025)).toBe(true);
  });
});

describe('data invariants', () => {
  it('every regular car costs no more than its own group budget', () => {
    for (const c of loadCatalog().filter((x) => x.group !== 'family')) {
      expect(c.monthlyCost).toBeLessThanOrEqual(rules.budgets[c.group as 'א']!);
    }
  });
  it('occupation table has 14 rows and agrees with the 6 sample employees on group', () => {
    const occ = new Map(loadOccupations().map((o) => [o.name, o]));
    expect(loadOccupations()).toHaveLength(14);
    expect(loadSampleEmployees()).toHaveLength(6);
    for (const e of loadSampleEmployees()) expect(occ.get(e.occupation)?.group).toBe(e.group);
  });
  it('family-track car ids exist in the catalogue', () => {
    const ids = new Set(loadCatalog().map((c) => c.id));
    for (const id of rules.familyTrack.cars) expect(ids.has(id)).toBe(true);
  });
});
