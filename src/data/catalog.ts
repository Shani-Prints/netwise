import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { GroupCodeSchema, type Rules } from '../config/rulesSchema';
import type { CarSpec, GroupCode, OccupationSpec } from '../engine/types';
import { lookupUsageValue, type UsageIndex } from './usageValues';

const dataDir = () => process.env.NETWISE_DATA_DIR ?? path.join(process.cwd(), 'data');
const readJson = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(dataDir(), 'generated', name), 'utf8'));

export const CatalogCarSchema = z.object({
  id: z.string(),
  group: z.union([GroupCodeSchema, z.literal('family')]),
  makerName: z.string(),
  makerCode: z.string(),
  modelName: z.string(),
  modelCode: z.string(),
  modelDescription: z.string(),
  registrationYear: z.number().int(),
  drive: z.enum(['petrol', 'hybrid', 'plugin', 'electric']),
  listPrice: z.number(),
  usageValue: z.number(),
  monthlyCost: z.number(),
  defaultParticipation: z.number(),
  vehicleTypeCode: z.string(),
  ambiguousCandidates: z.number().int(),
});
export type CatalogCar = z.infer<typeof CatalogCarSchema>;

export const OccupationRowSchema = z.object({
  name: z.string(),
  group: GroupCodeSchema,
  carMandatory: z.boolean(),
  waiverAllowed: z.boolean(),
  maintenance: z.number(),
});

export const SampleEmployeeSchema = z.object({
  id: z.string(),
  name: z.string(),
  occupation: z.string(),
  group: GroupCodeSchema,
  base: z.number(),
  commissions: z.number(),
  bonus: z.number(),
  pensionPct: z.number(),
  studyFundPct: z.number(),
  creditPoints: z.number(),
  childrenUnder23: z.number().int(),
  currentCar: z.union([z.object({ kind: z.literal('waiver') }), z.object({ kind: z.literal('car'), carId: z.string() })]),
  currentParticipation: z.number(),
  question: z.string(),
});
export type SampleEmployee = z.infer<typeof SampleEmployeeSchema>;

let catalogCache: CatalogCar[] | undefined;
let occCache: OccupationSpec[] | undefined;
let sampleCache: SampleEmployee[] | undefined;

export function loadCatalog(): CatalogCar[] {
  catalogCache ??= z.array(CatalogCarSchema).parse(readJson('catalog.json'));
  return catalogCache;
}
export function loadOccupations(): OccupationSpec[] {
  occCache ??= z.array(OccupationRowSchema).parse(readJson('occupations.json'));
  return occCache;
}
export function loadSampleEmployees(): SampleEmployee[] {
  sampleCache ??= z.array(SampleEmployeeSchema).parse(readJson('sample-employees.json'));
  return sampleCache;
}

export const getCatalogCar = (id: string): CatalogCar | undefined => loadCatalog().find((c) => c.id === id);
export const getOccupation = (name: string): OccupationSpec | undefined => loadOccupations().find((o) => o.name === name);

/** Display name, e.g. "קיה NIRO (2025)". */
export const carLabel = (c: CatalogCar): string => `${c.makerName} ${c.modelName} (${c.registrationYear})`;

/**
 * Builds the engine's CarSpec. The usage value is taken from the official dataset by its full key, NOT copied
 * from the spreadsheet; a mismatch with the catalogue is an error (data drift must be visible).
 */
export function toCarSpec(car: CatalogCar, usage: UsageIndex): CarSpec {
  const hit = lookupUsageValue(usage, {
    registrationYear: car.registrationYear,
    makerCode: car.makerCode,
    modelCode: car.modelCode,
    vehicleTypeCode: car.vehicleTypeCode,
  });
  if (hit.status !== 'found') throw new Error(`usage value for ${car.id} not found in dataset`);
  return {
    id: car.id,
    name: carLabel(car),
    group: car.group,
    monthlyCost: car.monthlyCost,
    usageValue: hit.row.usageValue,
    isElectric: car.drive === 'electric',
    defaultParticipation: car.defaultParticipation,
  };
}

/** Cars the employee may choose (own group or lower, plus the family track with enough children). */
export function allowedCars(group: GroupCode, childrenUnder23: number, rules: Rules): CatalogCar[] {
  const own = rules.groupOrder.indexOf(group);
  return loadCatalog().filter((c) => {
    if (c.group === 'family') {
      return rules.familyTrack.cars.includes(c.id) && childrenUnder23 >= rules.familyTrack.minChildren;
    }
    return rules.groupOrder.indexOf(c.group) <= own;
  });
}
