import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetChatRateLimit } from '../../src/agent/chatHandler';
import { getCatalogCar, loadCatalog } from '../../src/data/catalog';
import { he } from '../../src/components/car-advisor/content/he';
import { createChatStore } from '../../src/components/car-advisor/chatStore';
import type { AdvisorApiClient } from '../../src/components/car-advisor/contract/apiClient';
import type { ApiCarChoices, ApiEmployeeState } from '../../src/components/car-advisor/contract/apiTypes';
import { CarChoices } from '../../src/components/car-advisor/messages/CarChoices';
import { Client, freshRepo, PROFILE, restoreEnv, setupEnv, type Json } from '../api/harness';

// Mock API and mock data only.

beforeEach(() => {
  setupEnv();
  freshRepo();
  resetChatRateLimit();
});
afterEach(() => restoreEnv());

const choicesOf = async (c: Client): Promise<Json> => (await c.state()).body.carChoices;
const groupsOf = (choices: Json): Set<string> => new Set((choices.cars as { id: string }[]).map((c) => getCatalogCar(c.id)!.group));
const WAIVER_OK = { occupation: 'מפקח/ת איכות במפעל', group: 'א' };
const WAIVER_NO = { occupation: 'נציג/ת מכירות שטח', group: 'ב' };

describe('the server builds carChoices from the eligibility function', () => {
  it('group ג: own group and lower, nothing higher; names only', async () => {
    const e = new Client();
    await e.updateProfile(PROFILE);
    const c = await choicesOf(e);
    expect(c.purpose).toBe('target');
    expect([...groupsOf(c)].sort()).toEqual(['א', 'ב', 'ג']);
    for (const car of c.cars) {
      expect(car.label).not.toMatch(/CAR-\d+/);
      expect(['electric', 'hybrid', 'plugin', 'petrol']).toContain(car.drive);
      expect(car.fuel).not.toBe('');
    }
  });

  it('group ב: only groups א and ב', async () => {
    const e = new Client();
    await e.updateProfile({ ...PROFILE, ...WAIVER_NO });
    expect([...groupsOf(await choicesOf(e))].sort()).toEqual(['א', 'ב']);
  });

  it('family-track cars only with 4 or more children', async () => {
    const family = loadCatalog().filter((c) => c.group === 'family').map((c) => c.id);
    expect(family.length).toBeGreaterThan(0);
    for (const [children, expected] of [[0, false], [2, false], [3, false], [4, true], [5, true]] as const) {
      freshRepo();
      const e = new Client();
      await e.updateProfile({ ...PROFILE, childrenUnder23: children });
      const ids = ((await choicesOf(e)).cars as { id: string }[]).map((c) => c.id);
      for (const id of family) expect(ids.includes(id), `${children} children, ${id}`).toBe(expected);
    }
  });

  it('waiverAllowed only for an occupation that allows giving up the car', async () => {
    const yes = new Client();
    await yes.updateProfile({ ...PROFILE, ...WAIVER_OK });
    expect((await choicesOf(yes)).waiverAllowed).toBe(true);
    const no = new Client();
    await no.updateProfile({ ...PROFILE, ...WAIVER_NO });
    expect((await choicesOf(no)).waiverAllowed).toBe(false);
  });

  it('absent while the current car or the participation is missing, and once an alternative is chosen', async () => {
    const { currentCar: _c, currentParticipation: _p, ...noCar } = PROFILE;
    const a = new Client();
    await a.updateProfile(noCar);
    expect(await choicesOf(a)).toBeNull();
    const b = new Client();
    await b.updateProfile(PROFILE);
    expect((await choicesOf(b)).purpose).toBe('target');
    await b.select({ kind: 'car', carId: 'CAR-06' });
    expect(await choicesOf(b)).toBeNull();
  });

  it('restored by the state read (a refresh) as long as the bot is waiting, with the same content', async () => {
    const e = new Client();
    await e.updateProfile(PROFILE);
    expect(await choicesOf(e)).toEqual(await choicesOf(e));
    expect((await choicesOf(e)).cars.length).toBeGreaterThan(5);
  });
});

// ---------------------------------------------------------------- UI

/** Walks a React element tree (no DOM needed) and returns the <button> elements. */
function buttonsIn(node: ReactNode, out: ReactElement<Json>[] = []): ReactElement<Json>[] {
  if (Array.isArray(node)) node.forEach((n) => buttonsIn(n, out));
  else if (isValidElement(node)) {
    const el = node as ReactElement<Json>;
    if (el.type === 'button') out.push(el);
    buttonsIn(el.props.children, out);
  }
  return out;
}
const render = (choices: ApiCarChoices, extra: { disabled?: boolean; onChoose?: (m: string) => void } = {}) =>
  CarChoices({ choices, disabled: extra.disabled, onChoose: extra.onChoose ?? (() => {}) });

const car = (id: string, label: string, drive: ApiCarChoices['cars'][number]['drive']) => ({ id, label, fuel: 'x', drive });
const target: ApiCarChoices = {
  purpose: 'target',
  waiverAllowed: false,
  cars: [car('1', 'קיה PICANTO (2025)', 'petrol'), car('2', 'טויוטה COROLLA (2025)', 'hybrid'), car('3', 'בי ווי די ATTO 3 (2025)', 'electric'), car('4', 'פולסטאר 2 (2025)', 'electric'), car('5', 'קיה NIRO (2025)', 'plugin')],
};

describe('the car buttons (render)', () => {
  it('groups by fuel with electric first, and each button shows only the car name', () => {
    const html = renderToStaticMarkup(createElement(CarChoices, { choices: target, onChoose: () => {} }));
    const at = (t: string) => html.indexOf(t);
    expect(at(he.api.carChoices.electric)).toBeGreaterThan(-1);
    expect(at(he.api.carChoices.electric)).toBeLessThan(at(he.api.carChoices.hybrid));
    expect(at(he.api.carChoices.hybrid)).toBeLessThan(at(he.api.carChoices.petrol));
    expect(html).toContain(he.api.carChoices.titleTarget);
    // plug-in hybrids are listed with the hybrids
    expect(at('קיה NIRO')).toBeGreaterThan(at(he.api.carChoices.hybrid));
    expect(at('קיה NIRO')).toBeLessThan(at(he.api.carChoices.petrol));
    expect(html).not.toMatch(/CAR-\d+/);
  });

  it('real, labelled, enabled buttons; the waiver button only when allowed', () => {
    const buttons = buttonsIn(render(target));
    expect(buttons).toHaveLength(5);
    for (const b of buttons) {
      expect(b.props.type).toBe('button');
      expect(b.props['aria-label']).toBeTruthy();
      expect(b.props.disabled).toBe(false);
    }
    expect(renderToStaticMarkup(createElement(CarChoices, { choices: target, onChoose: () => {} }))).not.toContain(he.api.carChoices.waiver);
    const withWaiver = renderToStaticMarkup(createElement(CarChoices, { choices: { ...target, waiverAllowed: true }, onChoose: () => {} }));
    expect(withWaiver).toContain(he.api.carChoices.waiver);
    expect(buttonsIn(render({ ...target, waiverAllowed: true }))).toHaveLength(6);
  });

  it('every button is disabled while a request runs', () => {
    for (const b of buttonsIn(render({ ...target, waiverAllowed: true }, { disabled: true }))) expect(b.props.disabled).toBe(true);
  });

  it('a click sends the expected message: "compare to <name>", or giving up the car', () => {
    const sent: string[] = [];
    const buttons = buttonsIn(render({ ...target, waiverAllowed: true }, { onChoose: (m) => sent.push(m) }));
    buttons.forEach((b) => b.props.onClick());
    expect(sent).toContain('אני רוצה להשוות ל-בי ווי די ATTO 3 (2025)');
    expect(sent).toContain(he.api.carChoices.pickWaiver);
    expect(sent).toHaveLength(6);
  });

  it('the current-car list is labelled as the CURRENT car, has no waiver button, and a click says so', () => {
    const current: ApiCarChoices = { purpose: 'current', waiverAllowed: true, cars: [car('9', 'בי ווי די SEAL (2025)', 'electric'), car('8', 'בי ווי די ATTO 3 (2025)', 'electric')] };
    const html = renderToStaticMarkup(createElement(CarChoices, { choices: current, onChoose: () => {} }));
    expect(html).toContain(he.api.carChoices.titleCurrent);
    expect(html).not.toContain(he.api.carChoices.titleTarget);
    expect(html).not.toContain(he.api.carChoices.waiver);
    const sent: string[] = [];
    const buttons = buttonsIn(render(current, { onChoose: (m) => sent.push(m) }));
    buttons[0]!.props.onClick();
    expect(sent).toEqual(['הרכב הנוכחי שלי הוא בי ווי די SEAL (2025)']);
    expect(sent[0]).not.toContain('להשוות');
  });
});

// ---------------------------------------------------------------- controller / store

const emptyState = (carChoices: ApiCarChoices | null): ApiEmployeeState =>
  ({
    messages: [],
    profile: { fieldSources: {}, fieldGaps: {} },
    alternative: null,
    comparison: null,
    todayOnly: { status: 'missing', missingFields: [], missingText: [] },
    escalation: { needsReference: false },
    questions: [],
    awaitingRepresentative: false,
    repAnswers: {},
    updates: { newAnswers: false, updatedFields: [] },
    carChoices,
  }) as ApiEmployeeState;

describe('the click goes through the normal send path', () => {
  it('the store keeps carChoices from the state, and a click sends one normal message (no new endpoint)', async () => {
    const sendMessage = vi.fn(async () => ({ assistantText: 'ok' }));
    const getState = vi.fn(async () => emptyState(target));
    const api = { ensureSession: async () => {}, sendMessage, getState } as unknown as AdvisorApiClient;
    const store = createChatStore(api);
    await store.load();
    expect(store.getState().carChoices?.cars).toHaveLength(5);
    // what the controller's chooseCar does: the message is put in the draft and sent like typed text
    const message = (target.cars[2]!.label && `אני רוצה להשוות ל-${target.cars[2]!.label}`) as string;
    store.setDraft(message);
    getState.mockResolvedValueOnce(emptyState(null));
    await store.submit();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(message);
    expect(store.getState().carChoices).toBeNull(); // gone after the choice
  });
});
