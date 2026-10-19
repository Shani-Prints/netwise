import { describe, expect, it } from 'vitest';
import { askNextFields, MAX_ASK } from '../../src/agent/askNext';
import { checkProvenance, statedNumbers, statedZero, type ProvenanceField } from '../../src/agent/provenance';

/** true when the value is backed by the message(s). */
const backed = (field: ProvenanceField, value: number, ...messages: string[]) => checkProvenance({ [field]: value }, messages).length === 0;

describe('provenance: formats the employee may write', () => {
  it('percentages: with or without the % sign, with the word אחוז, or as a Hebrew number word', () => {
    for (const m of ['הפנסיה שלי 6%', 'פנסיה 6 אחוז', 'פנסיה 6 אחוזים', 'פנסיה: 6', 'שישה אחוז פנסיה', 'הפרשה של 6 %']) {
      expect(backed('pensionPct', 6, m), m).toBe(true);
    }
    for (const m of ['קרן השתלמות 2.5%', 'קרן השתלמות 2.5 אחוז', 'קרן השתלמות 2,5 אחוז', 'קרן השתלמות 2.5']) {
      expect(backed('studyFundPct', 2.5, m), m).toBe(true);
    }
  });

  it('salary: 18,500 / 18500 / 18.500 / 18 אלף / 18.5 אלף / 18K / Hebrew words', () => {
    for (const m of ['השכר שלי 18,500', 'השכר שלי 18500', 'שכר בסיס 18.500 ש"ח', 'מרוויחה 18.5 אלף', 'מרוויח 18.5K', 'שכר 18,500 שקל']) {
      expect(backed('base', 18500, m), m).toBe(true);
    }
    for (const m of ['שכר של 18 אלף', 'משכורת של 18 אלף', 'שכר 18K', 'שכר שמונה עשר אלף', 'שכר שמונה עשרה אלף']) {
      expect(backed('base', 18000, m), m).toBe(true);
    }
    expect(backed('base', 20000, 'אני מרוויחה עשרים אלף')).toBe(true);
    expect(backed('base', 21000, 'עשרים ואחד אלף')).toBe(true);
    expect(backed('bonus', 5000, 'בונוס של 5 אלפים')).toBe(true);
  });

  it('credit points and participation', () => {
    for (const m of ['2.75 נקודות זיכוי', 'נקודות זיכוי: 2,75', '2.75']) expect(backed('creditPoints', 2.75, m), m).toBe(true);
    for (const m of ['משלמת השתתפות של 300 ₪', 'השתתפות 300', 'אני משלם 300']) expect(backed('currentParticipation', 300, m), m).toBe(true);
  });

  it('children: digits, Hebrew number words (masculine and feminine) and "none"', () => {
    const words: [number, string][] = [
      [1, 'יש לי ילד אחד'],
      [1, 'יש לי אחת'],
      [2, 'שני ילדים'],
      [2, 'שתי בנות'],
      [2, 'יש לי שניים'],
      [3, 'שלושה ילדים'],
      [4, 'ארבעה ילדים'],
      [5, 'חמישה ילדים'],
      [6, 'שישה ילדים'],
      [7, 'שבעה ילדים'],
      [8, 'שמונה ילדים'],
      [9, 'תשעה ילדים'],
      [10, 'עשרה ילדים'],
      [12, 'שנים עשר ילדים'],
      [2, '2 ילדים'],
    ];
    for (const [n, m] of words) expect(backed('childrenUnder23', n, m), m).toBe(true);
    for (const m of ['אין לי ילדים', 'בלי ילדים', 'ללא ילדים', 'אפס ילדים', '0 ילדים']) expect(backed('childrenUnder23', 0, m), m).toBe(true);
  });

  it('"none" in words is accepted as 0 for the field it is said about', () => {
    expect(backed('commissions', 0, 'אין לי עמלות')).toBe(true);
    expect(backed('commissions', 0, 'בלי עמלות ובלי בונוס')).toBe(true);
    expect(backed('bonus', 0, 'בלי עמלות ובלי בונוס')).toBe(true);
    expect(backed('bonus', 0, 'ללא בונוס')).toBe(true);
    expect(backed('currentParticipation', 0, 'אין השתתפות')).toBe(true);
    expect(backed('currentParticipation', 0, 'אני לא משלם כלום')).toBe(true);
    expect(backed('pensionPct', 0, 'אין לי פנסיה')).toBe(true);
    expect(backed('studyFundPct', 0, 'בלי קרן השתלמות')).toBe(true);
    expect(backed('creditPoints', 0, 'אין לי נקודות זיכוי')).toBe(true);
  });
});

describe('provenance: a number the employee did not write is NOT backed', () => {
  it('a value that appears nowhere', () => {
    expect(backed('pensionPct', 6, 'השכר שלי 18,500')).toBe(false);
    expect(backed('base', 18500, 'השכר שלי 1850')).toBe(false);
    expect(backed('base', 1850, 'השכר שלי 18,500')).toBe(false);
    expect(backed('creditPoints', 2.75, 'נקודות זיכוי 2.5')).toBe(false);
    expect(backed('childrenUnder23', 2, 'יש לי שלושה ילדים')).toBe(false);
    expect(backed('base', 18500, 'אני מנהלת מוצר')).toBe(false);
    expect(backed('base', 18500)).toBe(false); // no messages at all
  });

  it('zero is backed only when it is said about THAT field', () => {
    expect(backed('commissions', 0, 'השכר שלי 18,500')).toBe(false);
    expect(backed('bonus', 0, 'אין לי ילדים')).toBe(false);
    expect(backed('childrenUnder23', 0, 'בלי עמלות')).toBe(false);
    expect(backed('bonus', 0, 'אין לי ילדים ויש לי בונוס של 500')).toBe(false); // "yes I have a bonus" is not "no bonus"
    expect(backed('bonus', 500, 'אין לי ילדים ויש לי בונוס של 500')).toBe(true);
    expect(backed('base', 0, 'אין שכר')).toBe(false); // a zero salary is never accepted from words
  });

  it('returns exactly the unsupported fields and supports a mix', () => {
    const r = checkProvenance({ base: 18500, pensionPct: 6, studyFundPct: 2.5, childrenUnder23: 2 }, ['שכר 18,500, קרן השתלמות 2.5%']);
    expect(r).toEqual(['pensionPct', 'childrenUnder23']);
    expect(checkProvenance({}, [])).toEqual([]);
  });

  it('comparison is exact: 18500 is not 18.5 and 6 is not 6.5', () => {
    expect(backed('pensionPct', 6, 'פנסיה 6.5%')).toBe(false);
    expect(backed('pensionPct', 6.5, 'פנסיה 6.5%')).toBe(true);
    expect(statedNumbers(['18,500']).has(18500)).toBe(true);
    expect(statedNumbers(['18,500']).has(18.5)).toBe(false);
  });

  it('statedZero is false for unrelated text', () => {
    expect(statedZero(['היי, אני רוצה לבדוק רכב'], 'childrenUnder23')).toBe(false);
  });
});

describe('askNext: what to ask TOGETHER', () => {
  it('keeps the engine order and caps at 4', () => {
    expect(MAX_ASK).toBe(4);
    expect(askNextFields(['commissions', 'bonus', 'studyFundPct', 'creditPoints', 'childrenUnder23', 'currentCar'])).toEqual([
      'commissions',
      'bonus',
      'studyFundPct',
      'creditPoints',
    ]);
    expect(askNextFields(['childrenUnder23', 'currentCar'])).toEqual(['childrenUnder23', 'currentCar']);
    expect(askNextFields([])).toEqual([]);
  });

  it('never asks for the group while the occupation is unknown (it is derived), and never for the occupation lookup', () => {
    expect(askNextFields(['group', 'occupation', 'base', 'occupationDetails', 'currentCar'])).toEqual(['occupation', 'base', 'currentCar']);
    expect(askNextFields(['group', 'base'])).toEqual(['group', 'base']); // occupation known but group in conflict: ask it
  });
});
