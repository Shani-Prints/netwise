import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetChatRateLimit } from '../../src/agent/chatHandler';
import { statedZero } from '../../src/agent/provenance';
import { Client, freshRepo, PROFILE, restoreEnv, setupEnv } from '../api/harness';
import { chat, fake, newEmployee, provider, say } from './fakes';

beforeEach(() => {
  setupEnv();
  freshRepo();
  resetChatRateLimit();
});
afterEach(() => restoreEnv());

type StatedField = 'commissions' | 'bonus' | 'pensionPct' | 'studyFundPct' | 'creditPoints' | 'childrenUnder23' | 'currentParticipation';
type ProfileView = { salaryInputs: Record<string, number | undefined>; childrenUnder23?: number };

describe('"אין לי X" is a stated zero (provenance statedZero)', () => {
  const cases: [string, StatedField][] = [
    ['אין לי קרן השתלמות', 'studyFundPct'],
    ['אין לי קרן השתלמות.', 'studyFundPct'],
    ['אין לי פנסיה', 'pensionPct'],
    ['אין לי נקודות זיכוי', 'creditPoints'],
    ['אין לי ילדים', 'childrenUnder23'],
    ['אין לי עמלות', 'commissions'],
    ['אין לי בונוס', 'bonus'],
    ['אין לי השתתפות ברכב', 'currentParticipation'],
    ['בלי קרן השתלמות', 'studyFundPct'],
    ['ללא פנסיה', 'pensionPct'],
  ];
  for (const [message, field] of cases) {
    it(`${message} -> ${field} = 0`, () => expect(statedZero([message], field)).toBe(true));
  }

  it('"I do not know" and a stated value are not a zero', () => {
    expect(statedZero(['אני לא יודע כמה קרן השתלמות יש לי'], 'studyFundPct')).toBe(false);
    expect(statedZero(['יש לי קרן השתלמות 2.5'], 'studyFundPct')).toBe(false);
    expect(statedZero(['אין לי מושג כמה פנסיה'], 'pensionPct')).toBe(false);
  });
});

async function partialEmployee(): Promise<Client> {
  const c = await newEmployee();
  await c.updateProfile({ occupation: PROFILE.occupation, group: PROFILE.group, base: PROFILE.base });
  return c;
}
const noop = () => ({ providers: [provider(fake(say('תודה.')))] });

describe('the server records the zero itself: nobody is asked to confirm 0%', () => {
  it('"אין לי קרן השתלמות" saves 0, opens no question and the field is not asked again', async () => {
    const e = await partialEmployee();
    const r = await chat(e, 'אין לי קרן השתלמות', noop());
    expect(r.status).toBe(200);
    const s = (await e.state()).body;
    expect(s.profile.salaryInputs.studyFundPct).toBe(0);
    expect(s.questions).toEqual([]);
    expect(s.awaitingRepresentative).toBe(false);
    expect(s.todayOnly.missingFields).not.toContain('studyFundPct');
    expect(r.body.pendingQuestions).toBeUndefined();
  });

  it('every similar phrase, field by field', async () => {
    const e = await partialEmployee();
    for (const [message, field, read] of [
      ['אין לי פנסיה', 'pensionPct', (p: ProfileView) => p.salaryInputs.pensionPct],
      ['אין לי נקודות זיכוי', 'creditPoints', (p: ProfileView) => p.salaryInputs.creditPoints],
      ['אין לי עמלות', 'commissions', (p: ProfileView) => p.salaryInputs.commissions],
      ['אין לי בונוס', 'bonus', (p: ProfileView) => p.salaryInputs.bonus],
      ['אין לי ילדים', 'childrenUnder23', (p: ProfileView) => p.childrenUnder23],
    ] as const) {
      await chat(e, message, noop());
      expect(read((await e.state()).body.profile), field).toBe(0);
    }
    expect((await e.state()).body.questions).toEqual([]);
  });

  it('"I do not know" is not turned into a zero', async () => {
    const e = await partialEmployee();
    await chat(e, 'אני לא יודע כמה קרן השתלמות יש לי', noop());
    expect((await e.state()).body.profile.salaryInputs.studyFundPct).toBeUndefined();
  });

  it('a field that already has a value is never overwritten by a later "אין לי"', async () => {
    const e = await partialEmployee();
    await e.updateProfile({ studyFundPct: 2.5 });
    await chat(e, 'אין לי קרן השתלמות', noop());
    expect((await e.state()).body.profile.salaryInputs.studyFundPct).toBe(2.5);
  });
});
