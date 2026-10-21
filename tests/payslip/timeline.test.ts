import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleChat, resetChatRateLimit } from '../../src/agent/chatHandler';
import { stripPayslipOffers } from '../../src/agent/flowText';
import { he } from '../../src/components/car-advisor/content/he';
import type { ApiComparison } from '../../src/components/car-advisor/contract/apiTypes';
import { InlineComparison } from '../../src/components/car-advisor/messages/InlineComparison';
import { PAYSLIP_OFFER_TEXT } from '../../src/lib/payslipMarker';
import { CHOOSE_CAR_TEXT } from '../../src/lib/repTemplates';
import { getRepo } from '../../src/db/repo';
import { SESSION_COOKIE } from '../../src/lib/session';
import { BASE, Client, freshRepo, loggedInRep, pendingEmployee, PROFILE, restoreEnv, setupEnv, type Json } from '../api/harness';
import { call, fake, fast, newEmployee, provider, say } from '../agent/fakes';

// Mock models and mock data only.

beforeEach(() => {
  setupEnv();
  freshRepo();
  resetChatRateLimit();
});
afterEach(() => restoreEnv());

async function send(c: Client, message: string, ...responses: unknown[]) {
  const headers = new Headers({ 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${c.cookie}` });
  const res = await handleChat(new Request(`${BASE}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ message }) }), {
    fallback: fast,
    providers: [provider(fake(...responses))],
  });
  const out = (await res.json()) as Json;
  return { status: res.status, text: out.assistantText as string, comparison: out.comparison as Json, choices: out.carChoices as Json };
}
const compare = (c: Client, message: string, carId: string) => send(c, message, call('calculate_comparison', { alternative: carId }), say('הנה.'));
const stateOf = async (c: Client) => (await c.state()).body as Json;
const assistantIds = (s: Json) => (s.messages as Json[]).filter((m) => m.role === 'assistant').map((m) => m.id as string);

async function twoComparisons(): Promise<Client> {
  const e = new Client();
  await e.updateProfile(PROFILE);
  await compare(e, 'תשווה ל-MG4', 'CAR-06');
  await compare(e, 'ועכשיו לאטו 3', 'CAR-10');
  return e;
}

describe('the timeline of comparisons (server)', () => {
  it('two comparisons stay in order, each attached to the bot message of its turn', async () => {
    const e = await twoComparisons();
    const s = await stateOf(e);
    const ids = assistantIds(s);
    expect(ids).toHaveLength(2);
    expect(s.comparisons.map((c: Json) => c.messageId)).toEqual(ids);
    expect(s.comparisons.map((c: Json) => c.comparison.alternativeLabel)).toEqual([expect.stringContaining('MG4'), expect.stringContaining('ATTO 3')]);
    for (const c of s.comparisons) expect(c.comparison.status).toBe('ok');
  });

  it('a refresh (a new state read) shows the same timeline; the numbers are the engine result of that turn', async () => {
    const e = await twoComparisons();
    const a = await stateOf(e);
    const b = await stateOf(e);
    expect(b.comparisons).toEqual(a.comparisons);
    // the older snapshot keeps its own numbers
    expect(a.comparisons[0].comparison.alternative.components.net).not.toBe(a.comparisons[1].comparison.alternative.components.net);
  });

  it('the old latest-comparison consumers keep working: comparison, the stored lastComparison and the chat response', async () => {
    const e = new Client();
    await e.updateProfile(PROFILE);
    const r = await compare(e, 'תשווה ל-MG4', 'CAR-06');
    expect(r.comparison.status).toBe('ok'); // the chat response still carries it
    await compare(e, 'ועכשיו לאטו 3', 'CAR-10');
    const s = await stateOf(e);
    expect(s.comparison).toEqual(s.comparisons[s.comparisons.length - 1].comparison); // the field is the latest
    const repo = await getRepo();
    const conv = (await repo.findConversationByUser(e.uid()))!;
    expect(conv.state.lastComparison?.alternativeLabel).toContain('ATTO 3'); // kept for the prompt and the other consumers
  });

  it('the result after a representative answered stays in the timeline too', async () => {
    const { client, reply } = await pendingEmployee();
    const rep = await loggedInRep();
    expect((await rep.repAnswer(reply.body.questions[0].id, '250')).status).toBe(200);
    const s = await stateOf(client);
    const last = assistantIds(s).pop();
    expect(s.comparisons.map((c: Json) => c.messageId)).toContain(last);
  });

  it('a comparison without a chat turn (a car picked through the API) has no snapshot: the live one is still returned', async () => {
    const e = new Client();
    await e.updateProfile(PROFILE);
    await e.select({ kind: 'car', carId: 'CAR-06' });
    const s = await stateOf(e);
    expect(s.comparisons).toEqual([]);
    expect(s.comparison.status).toBe('ok');
  });
});

// ---------------------------------------------------------------- UI

const comparison = (label: string, net: number, diff: number): ApiComparison =>
  ({
    status: 'ok',
    alternativeRef: { kind: 'car', carId: 'CAR-06' },
    alternativeLabel: label,
    eligible: true,
    eligibilityText: '',
    explanation: ['שורה א', 'שורה ב'],
    assumptions: [],
    missingFields: [],
    missingText: [],
    difference: diff,
    today: { label: 'x', components: { net: 10000 } as never, costVsBudget: null },
    alternative: { label: 'y', components: { net } as never, costVsBudget: null },
  }) as ApiComparison;

function buttonsIn(node: ReactNode, out: ReactElement<Json>[] = []): ReactElement<Json>[] {
  if (Array.isArray(node)) node.forEach((n) => buttonsIn(n, out));
  else if (isValidElement(node)) {
    const el = node as ReactElement<Json>;
    if (el.type === 'button') out.push(el);
    buttonsIn(el.props.children, out);
  }
  return out;
}

describe('InlineComparison (render)', () => {
  const c = comparison('מ.ג סין MG4 (2025)', 11000, 1000);

  it('an older comparison is one line: the car name and the difference, with a button to expand', () => {
    const html = renderToStaticMarkup(createElement(InlineComparison, { comparison: c, collapsed: true, onToggle: () => {} }));
    expect(html).toContain('מ.ג סין MG4 (2025)');
    expect(html).toContain('עלייה של');
    expect(html).toContain(he.api.comparison.showComparison);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('<table'); // the breakdown is hidden
  });

  it('the latest is expanded with the action row: another car, and giving up the car only when allowed', () => {
    const base = { comparison: c, collapsed: false, onToggle: () => {} };
    const plain = renderToStaticMarkup(createElement(InlineComparison, { ...base, actions: { waiverAllowed: false, disabled: false, onSend: () => {} } }));
    expect(plain).toContain(he.api.comparison.anotherCar);
    expect(plain).not.toContain(he.api.carChoices.waiver);
    const withWaiver = renderToStaticMarkup(createElement(InlineComparison, { ...base, actions: { waiverAllowed: true, disabled: false, onSend: () => {} } }));
    expect(withWaiver).toContain(he.api.carChoices.waiver);
  });

  it('the buttons send normal messages and are disabled while a request runs; no waiver button when the waiver is the result', () => {
    const sent: string[] = [];
    const view = InlineComparison({ comparison: c, collapsed: false, onToggle: () => {}, actions: { waiverAllowed: true, disabled: false, onSend: (m) => sent.push(m) } });
    buttonsIn(view).forEach((b) => b.props.onClick());
    expect(sent).toEqual([he.api.comparison.anotherCarMessage, he.api.carChoices.pickWaiver]);
    const busy = InlineComparison({ comparison: c, collapsed: false, onToggle: () => {}, actions: { waiverAllowed: true, disabled: true, onSend: () => {} } });
    for (const b of buttonsIn(busy)) expect(b.props.disabled).toBe(true);
    const waiverResult = { ...c, alternativeRef: { kind: 'waiver' as const } };
    const noWaiverButton = InlineComparison({ comparison: waiverResult, collapsed: false, onToggle: () => {}, actions: { waiverAllowed: true, disabled: false, onSend: () => {} } });
    expect(buttonsIn(noWaiverButton)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- item 3

describe('compare another car', () => {
  const ALLOWS_WAIVER = { occupation: 'מפקח/ת איכות במפעל', group: 'א' };

  it('after a result, "another car" brings the buttons back (compared car left out); they vanish after the next choice; refresh restores them', async () => {
    const e = new Client();
    await e.updateProfile(PROFILE);
    const first = await compare(e, 'תשווה ל-MG4', 'CAR-06');
    expect(first.choices).toBeUndefined(); // a result: no buttons, the action row is shown instead
    const another = await send(e, 'אני רוצה להשוות לרכב אחר', say('לאיזה רכב נרצה להשוות הפעם?'));
    expect(another.choices.purpose).toBe('target');
    expect(another.text).toContain(CHOOSE_CAR_TEXT);
    expect((another.choices.cars as { id: string }[]).map((x) => x.id)).not.toContain('CAR-06');
    // refresh: the state read shows the same buttons while the bot is waiting
    expect((await stateOf(e)).carChoices.purpose).toBe('target');
    // the next choice: a new comparison, the buttons are gone
    const picked = await compare(e, 'אני רוצה להשוות ל-ATTO 3', 'CAR-10');
    expect(picked.choices).toBeUndefined();
    expect((await stateOf(e)).carChoices).toBeNull();
  });

  it('the waiver is offered (state waiverAllowed and the button) only when the occupation allows it', async () => {
    const yes = new Client();
    await yes.updateProfile({ ...PROFILE, ...ALLOWS_WAIVER });
    expect((await stateOf(yes)).waiverAllowed).toBe(true);
    const no = new Client();
    await no.updateProfile({ ...PROFILE, occupation: 'נציג/ת מכירות שטח', group: 'ב' });
    expect((await stateOf(no)).waiverAllowed).toBe(false);
    const unknown = await newEmployee();
    expect((await stateOf(unknown)).waiverAllowed).toBe(false);
  });

  it('a reply that just compared never brings the buttons back by itself', async () => {
    const e = new Client();
    await e.updateProfile(PROFILE);
    const r = await send(e, 'תשווה', call('calculate_comparison', { alternative: 'CAR-06' }), say('אפשר להשוות גם לרכב אחר, איזה רכב להשוות?'));
    expect(r.choices).toBeUndefined();
    expect(r.text).not.toContain(CHOOSE_CAR_TEXT);
  });
});

// ---------------------------------------------------------------- item 4

describe('the payslip offer appears exactly once', () => {
  const count = (text: string, part: string) => text.split(part).length - 1;

  it('the model\'s own offer is removed when the server adds its own', async () => {
    const e = await newEmployee();
    const r = await send(e, 'שלום', say('בכיף! מה התפקיד, ומה שכר הבסיס? אפשר גם לצרף תלוש שכר כדי למלא את הפרטים באופן אוטומטי.'));
    expect(count(r.text, 'תלוש')).toBe(1);
    expect(r.text.endsWith(PAYSLIP_OFFER_TEXT)).toBe(true);
    expect(r.text).not.toContain('באופן אוטומטי');
  });

  it('a later reply of the model never repeats the offer', async () => {
    const e = await newEmployee();
    await send(e, 'שלום', say('מה התפקיד, ומה שכר הבסיס?'));
    const r2 = await send(e, 'עוד לא יודע', say('אפשר גם להעלות תלוש שכר. מה שכר הבסיס?'));
    expect(r2.text).not.toContain('תלוש');
    expect(r2.text).toContain('מה שכר הבסיס?');
  });

  it('a sentence that only says the details came from the payslip stays', () => {
    expect(stripPayslipOffers('הנתונים נלקחו מהתלוש שאושר. מה התפקיד?')).toBe('הנתונים נלקחו מהתלוש שאושר. מה התפקיד?');
    expect(stripPayslipOffers('אפשר לצרף תלוש שכר. מה התפקיד?')).toBe('מה התפקיד?');
  });
});
