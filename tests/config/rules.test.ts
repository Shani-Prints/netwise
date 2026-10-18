import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ELECTRIC_DRIVE_LABEL, parseRules, type Rules } from '../../src/config/rulesSchema';
import type { ConversationState } from '../../src/db/types';
import { buildComparison } from '../../src/lib/comparison';
import { demoProfiles, employeeUserId, seedStateFor } from '../../src/lib/demoUsers';
import { rules, usage } from '../helpers';

const raw = () => JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'strauss-rules.json'), 'utf8'));

// BYD Atto 3 (dataset drive code 3 = electric), identified only by dataset keys.
const atto3 = {
  kind: 'dataset' as const,
  makerCode: '01014',
  modelCode: '00003',
  vehicleTypeCode: '1',
  registrationYear: 2025,
  label: 'בי ווי די ATTO 3',
};

/** Today's electric gross-up for an employee whose CURRENT car is the Atto 3, using the given rules. */
function todayEvGrossUp(r: Rules): number {
  const id = employeeUserId('E-001');
  const state: ConversationState = { ...seedStateFor(id), currentCar: atto3 };
  const { view } = buildComparison({
    profile: demoProfiles().find((p) => p.userId === id)!,
    state,
    alternative: { kind: 'car', carId: 'CAR-09' },
    rules: r,
    usage,
  });
  if (view.status !== 'ok') throw new Error(`expected ok, got ${view.status}`);
  return view.today!.components.evGrossUp;
}

describe('electricDriveLabel', () => {
  it('data/strauss-rules.json declares it, and it is one of the driveField words', () => {
    const json = raw();
    expect(json.valueOfUse.electricDriveLabel).toBe('חשמלי');
    expect(Object.values(json.valueOfUse.driveField)).toContain(json.valueOfUse.electricDriveLabel);
    expect(rules.valueOfUse.electricDriveLabel).toBe('חשמלי');
  });

  it('an older rules file without the field still loads and falls back to today\'s word', () => {
    const old = raw();
    delete old.valueOfUse.electricDriveLabel;
    const parsed = parseRules(old);
    expect(parsed.valueOfUse.electricDriveLabel).toBe(DEFAULT_ELECTRIC_DRIVE_LABEL);
    expect(DEFAULT_ELECTRIC_DRIVE_LABEL).toBe('חשמלי');
  });

  it('electric detection works with the real rules, with an older file, and with a hand-built object lacking the key', () => {
    const old = raw();
    delete old.valueOfUse.electricDriveLabel;
    const { electricDriveLabel: _dropped, ...withoutKey } = rules.valueOfUse;
    expect(todayEvGrossUp(rules)).toBeGreaterThan(0);
    expect(todayEvGrossUp(parseRules(old))).toBeCloseTo(todayEvGrossUp(rules), 9);
    expect(todayEvGrossUp({ ...rules, valueOfUse: withoutKey } as Rules)).toBeCloseTo(todayEvGrossUp(rules), 9);
  });

  it('is really read from the rules: a different label turns the electric detection off', () => {
    const other = { ...rules, valueOfUse: { ...rules.valueOfUse, electricDriveLabel: 'לא-קיים' } };
    expect(todayEvGrossUp(other)).toBe(0);
  });

  it('rejects an empty label', () => {
    const bad = raw();
    bad.valueOfUse.electricDriveLabel = '';
    expect(() => parseRules(bad)).toThrow();
  });
});
