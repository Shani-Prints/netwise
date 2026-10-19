import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetChatRateLimit } from '../../src/agent/chatHandler';
import { guardResponse } from '../../src/agent/guard';
import { newCollector } from '../../src/agent/tools';
import { NEUTRAL_FALLBACK_HE } from '../../src/agent/agent';
import { FIELD_NAME_HE } from '../../src/lib/repQuestions';
import { repUpdatedText, STATUS_TEXT } from '../../src/lib/repTemplates';
import { Client, freshRepo, loggedInRep, PROFILE, restoreEnv, setupEnv, type Json } from '../api/harness';
import { call, chat, fake, provider, say } from './fakes';
import { employeeWithout, openQuestion, openFor, unavailable } from './repTextHelpers';

beforeEach(() => {
  setupEnv();
  freshRepo();
  resetChatRateLimit();
});
afterEach(() => restoreEnv());

const system = (m: { doGenerateCalls: { prompt: unknown }[] }) =>
  JSON.stringify(((m.doGenerateCalls[0]?.prompt ?? []) as Json[]).filter((x) => x.role === 'system'));
const repQuestions = async () => (await (await loggedInRep()).repQuestions()).body.questions as Json[];

describe('the employee says she does not know her credit points (scripted model)', () => {
  it('a profile_field_unknown question is opened in the SAME turn and the bot asks for no name or number', async () => {
    const e = await employeeWithout(['creditPoints']);
    const text = 'לא נורא, שלחתי שאלה לנציג לגבי נקודות הזיכוי. בינתיים נמשיך עם שאר הפרטים.';
    const m = fake(call('mark_field_unknown', { fields: ['creditPoints'] }), say(text));
    const r = await chat(e, 'אין לי מושג כמה נקודות זיכוי יש לי', { providers: [provider(m)], interpret: unavailable });
    expect(r.status).toBe(200);
    const qs = await repQuestions();
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({ kind: 'profile_field_unknown', field: 'creditPoints', status: 'open' });
    expect(r.body.assistantText).toBe(text); // accepted by the guard: a question really was opened this turn
    expect(r.body.assistantText).not.toMatch(/מספר עובד|מזהה|תעודת זהות|איך קוראים לך/);
    expect(r.body.pendingQuestions).toHaveLength(1);
    expect((await e.state()).body.escalation).toEqual({ needsReference: false });
    // nothing in what the bot was told asks for an identification
    expect(system(m)).toContain('NEVER ask the employee for a name, an employee number or any other identification');
    expect(system(m)).not.toMatch(/askReference|optional reference/);
  });
});

describe('the system message after a representative answer is one fixed template', () => {
  const PREFIX = 'הנציג עדכן את הנתון';
  const TAIL = 'הערך נשמר בפרופיל שלך (הוזן על ידי נציג) ואפשר לתקן אותו בכל שלב.';
  const answered = async (field: Parameters<typeof openQuestion>[1][number], value: string, without: string[]) => {
    const e = await employeeWithout(without, false);
    await openQuestion(e, [field]);
    expect((await (await loggedInRep()).repAnswer((await openFor(field)).id, value)).status).toBe(200);
    return ((await e.state()).body.messages as Json[]).map((m) => m.content as string);
  };

  it('percent, points and shekels use the existing formatter and never depend on agreement', async () => {
    const cases: [Parameters<typeof openQuestion>[1][number], string, string[], string][] = [
      ['pensionPct', '6.5', ['pensionPct'], `${PREFIX} "${FIELD_NAME_HE.pensionPct}" ל-6.5%. ${TAIL}`],
      ['creditPoints', '2.75', ['creditPoints'], `${PREFIX} "${FIELD_NAME_HE.creditPoints}" ל-2.75. ${TAIL}`],
      ['base', '18500', ['base'], `${PREFIX} "${FIELD_NAME_HE.base}" ל-18,500 ₪. ${TAIL}`],
      ['childrenUnder23', '3', ['childrenUnder23'], `${PREFIX} "${FIELD_NAME_HE.childrenUnder23}" ל-3. ${TAIL}`],
      ['currentParticipation', '350', ['currentParticipation'], `${PREFIX} "${FIELD_NAME_HE.currentParticipation}" ל-350 ₪. ${TAIL}`],
    ];
    for (const [field, value, without, expected] of cases) {
      freshRepo();
      const all = await answered(field, value, without);
      expect(all, field).toContain(expected);
      expect(all.join('\n'), field).not.toContain('התקבל עדכון'); // the old, ungrammatical wording is gone
    }
  });

  it('a text value (group, occupation, car) is shown in quotes; the first notice is "הנציג ענה על השאלה שלך."', async () => {
    const e = new Client();
    await e.session();
    await openQuestion(e, ['group']);
    const rep = await loggedInRep();
    await rep.repAnswer((await openFor('group')).id, 'ב');
    const all = (await e.state()).body.messages.map((m: Json) => m.content as string);
    expect(all).toContain('הנציג ענה על השאלה שלך.');
    expect(all).toContain(repUpdatedText(FIELD_NAME_HE.group, 'ב', true));
    expect(repUpdatedText('עיסוק', 'מנהל/ת מוצר', true)).toBe(`${PREFIX} "עיסוק" ל"מנהל/ת מוצר". ${TAIL}`);
  });

  it('the template is the same for every field and never contains the representative\'s words', () => {
    for (const f of ['x', 'y']) expect(repUpdatedText(f, '1', false)).toBe(`${PREFIX} "${f}" ל-1. ${TAIL}`);
  });
});

describe('the guard: a claim that a question was sent needs a question that is really open', () => {
  const claims = ['שלחתי שאלה לנציג.', 'ושאלתי את הנציג.', 'פניתי לנציג בעניין הזה.', 'ביקשתי מהנציג הבהרה.', 'השאלה נשלחה לנציג.', 'שלחתי לנציג שאלה.'];

  it('is refused when nothing is open and nothing was opened this turn', () => {
    for (const text of claims) {
      const g = guardResponse(text, newCollector());
      expect(g, text).toMatchObject({ ok: false, reason: 'unsupported_rep_claim' });
    }
  });

  it('is accepted when a question was opened this turn, or one is already open', () => {
    const opened = newCollector();
    opened.escalations.push({ kind: 'profile_field_unknown', field: 'creditPoints', outcome: 'question_sent' });
    const waiting = newCollector();
    waiting.escalations.push({ kind: 'profile_field_unknown', field: 'creditPoints', outcome: 'waiting' });
    const fromTool = newCollector();
    fromTool.results.push({ tool: 'calculate_comparison', output: { status: 'missing_fields', representative: 'sent' } });
    for (const text of claims) {
      expect(guardResponse(text, opened).ok, text).toBe(true);
      expect(guardResponse(text, waiting).ok, text).toBe(true);
      expect(guardResponse(text, fromTool).ok, text).toBe(true);
      expect(guardResponse(text, newCollector(), [], { repOpen: true }).ok, text).toBe(true); // already open at the start of the turn
    }
  });

  it('a negation or an unrelated sentence is not a claim', () => {
    for (const text of ['לא שלחתי שאלה לנציג.', 'לא נשלחה שאלה לנציג.', 'הנציג עדיין לא ענה.', STATUS_TEXT.none]) {
      expect(guardResponse(text, newCollector()).ok, text).toBe(true);
    }
  });

  it('in the chat: a text that claims a question while none is open is replaced by a fixed fallback', async () => {
    const e = await employeeWithout(['creditPoints']);
    const claim = 'אין בעיה, שלחתי שאלה לנציג והוא יחזור אליך.';
    const r = await chat(e, 'מה קורה?', { providers: [provider(fake(say(claim)))], interpret: unavailable });
    expect(r.status).toBe(200);
    expect(r.body.assistantText).not.toContain('שלחתי שאלה לנציג');
    expect(r.body.assistantText.length).toBeGreaterThan(0);
    expect([NEUTRAL_FALLBACK_HE].length).toBe(1);
    expect(await repQuestions()).toEqual([]); // and no question was invented by the claim
    // the same sentence is accepted once the server really opened a question
    const ok = fake(call('mark_field_unknown', { fields: ['creditPoints'] }), say(claim));
    const r2 = await chat(e, 'אין לי מושג', { providers: [provider(ok)], interpret: unavailable });
    expect(r2.body.assistantText).toBe(claim);
    expect(await repQuestions()).toHaveLength(1);
    // and while it stays open, a later turn may mention it
    const later = await chat(e, 'ומה המצב?', { providers: [provider(fake(say('שלחתי שאלה לנציג, ועדיין מחכים לתשובה.')))], interpret: unavailable });
    expect(later.body.assistantText).toBe('שלחתי שאלה לנציג, ועדיין מחכים לתשובה.');
  });
});

void PROFILE;
