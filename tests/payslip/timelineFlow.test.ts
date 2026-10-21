import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleChat, resetChatRateLimit } from '../../src/agent/chatHandler';
import { createChatStore } from '../../src/components/car-advisor/chatStore';
import type { AdvisorApiClient } from '../../src/components/car-advisor/contract/apiClient';
import type { ApiComparison } from '../../src/components/car-advisor/contract/apiTypes';
import { buildTimeline, type TimelineItem } from '../../src/components/car-advisor/timeline';
import { he } from '../../src/components/car-advisor/content/he';
import { SESSION_COOKIE } from '../../src/lib/session';
import { BASE, Client, freshRepo, loggedInRep, pendingEmployee, PROFILE, restoreEnv, setupEnv, type Json } from '../api/harness';
import { call, fake, fast, provider, say } from '../agent/fakes';

// Mock models and mock API only. The timeline function is the one the widget renders from.

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
  return (await res.json()) as Json;
}

/** What the widget renders, in order, from a state read (a refresh). */
async function timelineOf(c: Client): Promise<TimelineItem[]> {
  const s = (await c.state()).body as Json;
  return buildTimeline({
    messages: (s.messages as Json[]).map((m) => ({ id: m.id, role: m.role, content: m.content })),
    comparisons: s.comparisons,
    comparison: s.comparison,
    carChoices: s.carChoices,
  });
}
const kinds = (items: TimelineItem[]) => items.map((i) => (i.kind === 'message' ? i.message.role : i.kind));

const family = { ...PROFILE, childrenUnder23: 5 };
const clickMessage = (label: string) => he.api.carChoices.pickTarget.replace('{label}', label);

async function carLabelOf(c: Client, pattern: RegExp): Promise<string> {
  const choices = ((await c.state()).body as Json).carChoices;
  return (choices.cars as { label: string }[]).find((x) => pattern.test(x.label))!.label;
}

describe('the real client path: click a car button -> result -> "another car" -> buttons', () => {
  it('result bubble, the comparison panel right under it, then the later messages and the buttons - also after a refresh', async () => {
    const e = new Client();
    await e.updateProfile(family);
    const santaFe = await carLabelOf(e, /SANTA FE/);

    const click = await send(e, clickMessage(santaFe), call('calculate_comparison', { alternative: santaFe }), say('הנה.'));
    expect(click.comparison.status).toBe('ok');
    expect(click.messageId).toBeTruthy(); // the response says where the comparison belongs
    const state1 = ((await e.state()).body as Json);
    const lastBot = [...(state1.messages as Json[])].reverse().find((m) => m.role === 'assistant');
    expect(click.messageId).toBe(lastBot.id);
    expect(state1.comparisons.map((c: Json) => c.messageId)).toEqual([lastBot.id]);

    const another = await send(e, he.api.comparison.anotherCarMessage, say('לאיזה רכב נרצה להשוות הפעם?'));
    expect(another.carChoices.purpose).toBe('target');

    const expected = ['user', 'assistant', 'comparison', 'user', 'assistant', 'carChoices'];
    expect(kinds(await timelineOf(e))).toEqual(expected);
    expect(kinds(await timelineOf(e))).toEqual(expected); // refresh: the same order
    expect(kinds(await timelineOf(e))).not.toContain('liveComparison'); // the "end of the chat" fallback is not used
    const cmp = (await timelineOf(e)).find((i) => i.kind === 'comparison') as Extract<TimelineItem, { kind: 'comparison' }>;
    expect(cmp.latest).toBe(true);
    expect(cmp.comparison.alternativeLabel).toContain('SANTA FE');
  });

  it('a second comparison is appended at its own place; the first one is collapsed (not the latest)', async () => {
    const e = new Client();
    await e.updateProfile(family);
    const santaFe = await carLabelOf(e, /SANTA FE/);
    await send(e, clickMessage(santaFe), call('calculate_comparison', { alternative: santaFe }), say('הנה.'));
    await send(e, he.api.comparison.anotherCarMessage, say('לאיזה רכב נרצה להשוות הפעם?'));
    const atto = await carLabelOf(e, /ATTO 3/);
    await send(e, clickMessage(atto), call('calculate_comparison', { alternative: atto }), say('הנה.'));

    const items = await timelineOf(e);
    expect(kinds(items)).toEqual(['user', 'assistant', 'comparison', 'user', 'assistant', 'user', 'assistant', 'comparison']);
    const comparisons = items.filter((i) => i.kind === 'comparison') as Extract<TimelineItem, { kind: 'comparison' }>[];
    expect(comparisons.map((c) => c.latest)).toEqual([false, true]);
    expect(comparisons[0]!.comparison.alternativeLabel).toContain('SANTA FE');
    expect(comparisons[1]!.comparison.alternativeLabel).toContain('ATTO 3');
  });
});

describe('every path that produces or changes the result gets its own snapshot', () => {
  it('the waiver path', async () => {
    const e = new Client();
    await e.updateProfile({ ...PROFILE, occupation: 'מפקח/ת איכות במפעל', group: 'א' });
    const s0 = (await e.state()).body as Json;
    expect(s0.waiverAllowed).toBe(true);
    await send(e, he.api.carChoices.pickWaiver, call('calculate_comparison', { alternative: 'waiver' }), say('הנה.'));
    const items = await timelineOf(e);
    expect(kinds(items)).toEqual(['user', 'assistant', 'comparison']);
    const c = items[2] as Extract<TimelineItem, { kind: 'comparison' }>;
    expect(c.comparison.alternativeRef).toEqual({ kind: 'waiver' });
  });

  it('a turn that only changes the numbers (the employee corrects a value) saves a new snapshot at THAT bot message, with no tool call for a comparison', async () => {
    const e = new Client();
    await e.updateProfile(PROFILE);
    await send(e, 'תשווה ל-MG4', call('calculate_comparison', { alternative: 'CAR-06' }), say('הנה.'));
    const before = (await e.state()).body as Json;
    const fix = await send(e, 'הפנסיה שלי היא 3', call('save_employee_data', { pensionPct: 3 }), say('עדכנתי.'));
    const after = (await e.state()).body as Json;
    expect(after.comparisons).toHaveLength(2);
    const lastBot = [...(after.messages as Json[])].reverse().find((m) => m.role === 'assistant');
    expect(after.comparisons[1].messageId).toBe(lastBot.id);
    expect(fix.messageId).toBe(lastBot.id);
    expect(after.comparisons[1].comparison.today.components.net).not.toBe(before.comparisons[0].comparison.today.components.net);
    expect(kinds(await timelineOf(e))).toEqual(['user', 'assistant', 'comparison', 'user', 'assistant', 'comparison']);
  });

  it('a turn that changes nothing adds no snapshot', async () => {
    const e = new Client();
    await e.updateProfile(PROFILE);
    await send(e, 'תשווה ל-MG4', call('calculate_comparison', { alternative: 'CAR-06' }), say('הנה.'));
    const quiet = await send(e, 'תודה', say('בבקשה.'));
    expect(quiet.comparison).toBeUndefined();
    expect(quiet.messageId).toBeUndefined(); // the plain reply keeps its contract
    expect((((await e.state()).body as Json).comparisons as Json[]).length).toBe(1);
  });

  it('the representative-answer path', async () => {
    const { client, reply } = await pendingEmployee();
    const rep = await loggedInRep();
    expect((await rep.repAnswer(reply.body.questions[0].id, '250')).status).toBe(200);
    const items = await timelineOf(client);
    expect(kinds(items).filter((k) => k === 'liveComparison')).toEqual([]);
    const botIndex = items.findLastIndex((i) => i.kind === 'message' && i.message.role === 'assistant');
    expect(items[botIndex + 1]?.kind).toBe('comparison'); // right under the bridge-line result bubble
  });

  it('an old conversation without any snapshot still shows the live comparison, at the end', async () => {
    const e = new Client();
    await e.updateProfile(PROFILE);
    await e.select({ kind: 'car', carId: 'CAR-06' }); // no chat turn: nothing to anchor to
    expect(kinds(await timelineOf(e))).toEqual(['liveComparison']);
  });
});

describe('the client anchors the result without a refresh', () => {
  it('the store puts the comparison of the response under that bot message even before the state read confirms it', async () => {
    const comparison = { status: 'ok', alternativeRef: { kind: 'car', carId: 'CAR-06' }, alternativeLabel: 'x' } as ApiComparison;
    const api = {
      ensureSession: async () => {},
      sendMessage: vi.fn(async () => ({ assistantText: 'הנה.', comparison, messageId: 'bot-1' })),
      getState: vi.fn(async () => {
        throw new Error('offline');
      }),
    } as unknown as AdvisorApiClient;
    const store = createChatStore(api);
    store.setDraft('אני רוצה להשוות ל-MG4');
    await store.submit();
    expect(store.getState().comparisons).toEqual([{ messageId: 'bot-1', comparison }]);
  });
});
