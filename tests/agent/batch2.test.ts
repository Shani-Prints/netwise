import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureCarGuidance, shortMissingSentence } from '../../src/agent/agent';
import { resetChatRateLimit } from '../../src/agent/chatHandler';
import { dropListedNames } from '../../src/agent/listDedupe';
import { newCollector } from '../../src/agent/tools';
import { carLabel, getCatalogCar, loadOccupations } from '../../src/data/catalog';
import { getRepo } from '../../src/db/repo';
import { currentCarYearAssumptionText, MORE_OPTIONS_TEXT, pickCarText } from '../../src/lib/repTemplates';
import { ATTO3, Client, freshRepo, loggedInRep, PROFILE, restoreEnv, setupEnv, type Json } from '../api/harness';
import { call, chat, fake, provider, say } from './fakes';
import { employeeWithout, openQuestion, repList, unavailable } from './repTextHelpers';

beforeEach(() => {
  setupEnv();
  freshRepo();
  resetChatRateLimit();
});
afterEach(() => restoreEnv());

const turn = (c: Client, message: string, ...responses: unknown[]) => chat(c, message, { providers: [provider(fake(...responses))], interpret: unavailable });
const systemNotices = async (e: Client) => ((await e.state()).body.messages as Json[]).filter((m) => m.role === 'system').map((m) => m.content as string);

describe('item 3: ONE system notice per applied answer', () => {
  it('one answer: one line "הנציג עדכן את הנתון ...", and no separate "הנציג ענה על השאלה שלך."', async () => {
    const e = await employeeWithout(['pensionPct']);
    await openQuestion(e, ['pensionPct']);
    const rep = await loggedInRep();
    const q = (await repList()).find((x) => x.field === 'pensionPct')!;
    expect((await rep.repAnswer(q.id, '6')).status).toBe(200);
    // before the employee reads anything the conversation has no notice at all (nothing was applied yet)
    const notices = await systemNotices(e);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('הנציג עדכן את הנתון');
    expect(notices[0]).toContain('6%');
    expect(notices.join('\n')).not.toContain('הנציג ענה על השאלה שלך');
    // reading again adds nothing
    await e.state();
    expect(await systemNotices(e)).toHaveLength(1);
  });

  it('several answers applied together: one merged notice that lists the fields', async () => {
    const e = await employeeWithout(['pensionPct', 'studyFundPct']);
    await openQuestion(e, ['pensionPct', 'studyFundPct']);
    const rep = await loggedInRep();
    for (const [field, value] of [['pensionPct', '6'], ['studyFundPct', '2.5']] as const) {
      expect((await rep.repAnswer((await repList()).find((x) => x.field === field)!.id, value)).status).toBe(200);
    }
    const notices = await systemNotices(e);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('הנציג עדכן כמה נתונים');
    expect(notices[0]).toContain('אחוז פנסיה');
    expect(notices[0]).toContain('אחוז קרן השתלמות');
    expect(notices[0]).toContain('6%');
    expect(notices[0]).toContain('2.5%');
  });
});

describe('item 5: the registration-year assumption of a catalogue car', () => {
  const CAR09 = getCatalogCar('CAR-09')!;
  const line = currentCarYearAssumptionText(CAR09.registrationYear, carLabel(CAR09));

  async function comparisonAfter(message: string) {
    const e = new Client();
    await e.session();
    await turn(e, message, say('בסדר.'));
    const { currentCar: _car, ...rest } = PROFILE; // everything except the car: the car comes from her message
    void _car;
    await e.updateProfile(rest);
    return (await e.select(ATTO3)).body.comparison;
  }

  it('the fixed template (data from the server)', () => {
    expect(line).toBe('הנחתי שנת רישום 2025 עבור טויוטה יפן COROLLA CROSS (2025) לפי הקטלוג. אם זו לא השנה הנכונה, כתבי לי את השנה.');
  });

  it('the year was not stated: one extra assumption line, and the year is not asked', async () => {
    const c = await comparisonAfter('הרכב שלי כרגע קורולה קרוס');
    expect(c.assumptions).toContain(line);
    expect(c.assumptions.filter((a: string) => a.includes('הנחתי שנת רישום'))).toHaveLength(1);
  });

  it('the year was stated: no such line', async () => {
    expect((await comparisonAfter('הרכב שלי כרגע קורולה קרוס 2025')).assumptions).not.toContain(line);
    expect((await comparisonAfter('הרכב שלי כרגע קורולה קרוס 2022')).assumptions.join('\n')).not.toContain('הנחתי שנת רישום');
  });

  it('the line goes away when the employee gives her own car', async () => {
    const e = new Client();
    await e.session();
    await turn(e, 'הרכב שלי כרגע קורולה קרוס', say('בסדר.'));
    const { currentCar: _car, ...rest } = PROFILE;
    void _car;
    await e.updateProfile(rest);
    await e.select(ATTO3);
    await e.updateProfile({ currentCar: { kind: 'car', carId: 'CAR-09' } }); // chosen explicitly from the list: not an assumption
    expect((await e.state()).body.comparison.assumptions).not.toContain(line);
  });
});

describe('item 6: pick-lists never hide options', () => {
  it('a bare "מנהל" shows ALL the matching occupations', async () => {
    const e = new Client();
    await e.session();
    const r = await turn(e, 'אני מנהל', call('save_employee_data', { occupation: 'מנהל' }), say('בסדר.'));
    const managers = loadOccupations().filter((o) => o.name.startsWith('מנהל'));
    expect(managers).toHaveLength(6);
    for (const o of managers) expect(r.body.assistantText, o.name).toContain(o.name);
  });

  it('cars: up to 5 and a line that more exist (only when more exist)', async () => {
    expect(MORE_OPTIONS_TEXT).toBe('יש עוד אפשרויות, אפשר לדייק את הדגם או השנה.');
    expect(pickCarText(['א', 'ב'], true)).toContain(MORE_OPTIONS_TEXT);
    expect(pickCarText(['א', 'ב'])).not.toContain(MORE_OPTIONS_TEXT);
    const repo = await getRepo();
    const e = new Client();
    await e.session();
    const issue = { role: 'alternative' as const, attempt: 0, opened: false, candidates: ['a', 'b', 'c', 'd', 'e'], text: 'x', pick: true, more: true };
    const text = await ensureCarGuidance('', { repo, actor: e.actor(), carIssues: [issue] }, newCollector());
    expect(text).toContain(MORE_OPTIONS_TEXT);
    expect(await ensureCarGuidance('', { repo, actor: e.actor(), carIssues: [{ ...issue, more: false }] }, newCollector())).not.toContain(MORE_OPTIONS_TEXT);
  });
});

describe('item 7: one block per list, and a short reply after a pick', () => {
  it('the model paragraph about the same cars is dropped: each car appears once', async () => {
    const e = new Client();
    await e.session();
    const modelText = 'אפשר להשוות לכמה דגמים של BYD:\n- BYD DOLPHIN\n- BYD ATTO 3\n- BYD SEAL\nמה העיסוק שלך?';
    const r = await turn(e, 'מה אם אעבור ל-BYD חשמלי?', say(modelText));
    const text: string = r.body.assistantText;
    expect(text).toContain('לא ברור לי לאיזה רכב התכוונת');
    for (const m of ['DOLPHIN', 'ATTO 3', 'SEAL']) expect(text.split(m).length - 1, m).toBe(1);
    expect(text).toContain('מה העיסוק שלך?'); // what the model asked besides the list stays
  });

  it('dropListedNames removes list lines, the intro line and single sentences, nothing else', () => {
    expect(dropListedNames('שלום. אפשר ATTO 3 או SEAL.\nשאלה אחרת?', ['ATTO 3', 'SEAL'])).toBe('שלום. אפשר ATTO 3 או SEAL.\nשאלה אחרת?'.split('\n')[1]);
    expect(dropListedNames('הנה:\n- א ATTO 3\n- ב SEAL\nמה העיסוק?', ['ATTO 3', 'SEAL'])).toBe('מה העיסוק?');
    expect(dropListedNames('כלום על רכב.', ['ATTO 3'])).toBe('כלום על רכב.');
  });

  it('she only picks from the list: one short sentence with what is still missing, not all the questions again', async () => {
    const e = new Client();
    await e.session();
    await turn(e, 'מה אם אעבור ל-BYD חשמלי?', say('איזה BYD?'));
    const long = 'תודה! כדי להמשיך אני צריך: עיסוק, שכר בסיס, עמלות, בונוס, אחוז פנסיה, קרן השתלמות, נקודות זיכוי, ילדים ורכב נוכחי. נתחיל?';
    const r = await turn(e, 'ATTO 3', say(long));
    const text: string = r.body.assistantText;
    expect(text.startsWith('מעולה, רשמתי.')).toBe(true);
    expect(text).not.toContain('נתחיל');
    expect(text.split('\n')).toHaveLength(1);
    expect(text).toContain('עיסוק');
  });

  it('a normal message after a pick-list is not shortened', async () => {
    const e = new Client();
    await e.session();
    await turn(e, 'מה אם אעבור ל-BYD חשמלי?', say('איזה BYD?'));
    const r = await turn(e, 'השכר שלי הוא 18500 ואני בקבוצה ג ויש לי עוד כמה שאלות על המסלול', say('הבנתי, רשמתי את השכר.'));
    expect(r.body.assistantText).toBe('הבנתי, רשמתי את השכר.');
  });

  it('shortMissingSentence is null when nothing is missing', async () => {
    const e = new Client();
    await e.updateProfile(PROFILE);
    expect(await shortMissingSentence(await getRepo(), e.actor())).toBeNull();
  });
});
