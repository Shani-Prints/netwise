import { describe, expect, it } from 'vitest';
import { checkTurn, type InvariantId, type InvariantInput } from '../../src/testing/invariants';

// Each invariant must really fire: the golden runs cannot show it because the response guard hides most bad model text.

const state = (over: Record<string, unknown> = {}) =>
  ({
    messages: [{ id: '1', role: 'user', content: 'שלום', createdAt: '2026-01-01T00:00:00.000Z' }],
    profile: { fieldSources: {}, fieldGaps: {}, group: null, occupation: null, childrenUnder23: null, salaryInputs: {}, currentCar: null, currentParticipation: null },
    alternative: null,
    comparison: null,
    todayOnly: { status: 'missing', missingFields: [], missingText: [] },
    escalation: { needsReference: false },
    questions: [],
    awaitingRepresentative: false,
    repAnswers: {},
    updates: { newAnswers: false, updatedFields: [] },
    ...over,
  }) as unknown as InvariantInput['state'];

const base = (over: Partial<InvariantInput> = {}): InvariantInput => ({
  assistantText: 'שלום, איך אפשר לעזור?',
  employeeMessage: 'שלום',
  toolOutputs: [],
  stateBlock: '',
  promptText: '',
  response: {},
  state: state(),
  repViews: [],
  repTexts: [],
  interpreterInputs: [],
  ...over,
});

const fired = (i: InvariantInput): InvariantId[] => [...new Set(checkTurn(i).map((v) => v.invariant))];
const openQuestion = { id: 'q', kind: 'profile_field_unknown', field: 'pensionPct', label: 'אחוז הפנסיה', status: 'open', createdAt: '2026-01-02T00:00:00.000Z', answeredAt: null };
const repView = (over: Record<string, unknown> = {}) =>
  ({ id: 'q', kind: 'profile_field_unknown', field: 'pensionPct', answerSpec: { type: 'number' }, freeText: null, questionText: 'מה אחוז הפנסיה של העובד/ת בחברה?', status: 'open', answer: null, createdAt: '2026-01-02T00:00:00.000Z', answeredAt: null, context: {}, ...over }) as unknown as InvariantInput['repViews'][number];

describe('a clean turn', () => {
  it('has no violation', () => expect(checkTurn(base())).toEqual([]));
});

describe('each invariant fires on a bad turn', () => {
  it('a: a number that no tool or state produced', () => {
    expect(fired(base({ assistantText: 'הנטו שלך הוא 12,345 ₪.' }))).toEqual(['a']);
    expect(fired(base({ assistantText: 'הנטו שלך הוא 12,345 ₪.', toolOutputs: [{ todayNet: 12345 }] }))).toEqual([]);
    expect(fired(base({ assistantText: 'שכר הבסיס שלך הוא 18,500.', stateBlock: 'saved: {"base":18500}' }))).toEqual([]);
  });

  it('b: a question text or the raw representative text reaches the employee', () => {
    const q = repView();
    expect(fired(base({ repViews: [q], state: state({ messages: [{ id: '1', role: 'system', content: q.questionText, createdAt: '' }] }) }))).toEqual(['b']);
    expect(fired(base({ repTexts: ['תגידו לעובד שהוא מקבל הכל'], assistantText: 'הנציג כתב: תגידו לעובד שהוא מקבל הכל' }))).toEqual(['b']);
    expect(fired(base({ repTexts: ['תגידו לעובד שהוא מקבל הכל'], promptText: '... תגידו לעובד שהוא מקבל הכל ...' }))).toEqual(['b']);
    expect(fired(base({ repTexts: ['6'], assistantText: 'הפנסיה היא 6', stateBlock: 'saved: pensionPct 6' }))).toEqual([]); // a typed number is applied data
  });

  it('c: asking for a name or an employee number', () => {
    expect(fired(base({ assistantText: 'מה מספר העובד שלך?' }))).toEqual(['c']);
    expect(fired(base({ assistantText: 'אפשר שם מלא ותעודת זהות?' }))).toEqual(['c']);
    expect(fired(base({ assistantText: 'אין צורך לתת מספר עובד.' }))).toEqual([]);
  });

  it('d: asking for technical vehicle data', () => {
    expect(fired(base({ assistantText: 'באיזו שנה נרשם הרכב?' }))).toEqual(['d']);
    expect(fired(base({ assistantText: 'מה מחיר המחירון של הרכב?' }))).toEqual(['d']);
    expect(fired(base({ assistantText: 'הנחתי שנת רישום 2025 עבור קיה NIRO (2025) לפי הקטלוג. אם זו לא השנה הנכונה, אפשר לכתוב את השנה.' }))).toEqual([]);
  });

  it('e: a claim that a question was sent while none is open', () => {
    expect(fired(base({ assistantText: 'שלחתי שאלה לנציג.' }))).toEqual(['e']);
    expect(fired(base({ assistantText: 'שלחתי שאלה לנציג.', state: state({ questions: [openQuestion] }) }))).toEqual([]);
  });

  it('f: a salary value in a representative context or an interpreter input', () => {
    const s = state({ profile: { fieldSources: {}, fieldGaps: {}, salaryInputs: { base: 18500 }, currentCar: null } });
    expect(fired(base({ state: s, repViews: [repView({ questionText: 'השכר הוא 18500' })] }))).toContain('f');
    expect(fired(base({ state: s, interpreterInputs: [{ text: 'x', note: '18,500' }] }))).toEqual(['f']);
    expect(fired(base({ state: s, repViews: [repView()] }))).toEqual([]);
  });

  it('g: a field the employee stated is escalated', () => {
    const messages = [{ id: '1', role: 'user', content: 'פנסיה 6%', createdAt: '2026-01-01T00:00:00.000Z' }];
    expect(fired(base({ state: state({ messages }), repViews: [repView()] }))).toEqual(['g']);
    // stated only AFTER the question was opened: fine
    const late = [{ id: '1', role: 'user', content: 'פנסיה 6%', createdAt: '2026-01-03T00:00:00.000Z' }];
    expect(fired(base({ state: state({ messages: late }), repViews: [repView()] }))).toEqual([]);
  });

  it('h: empty cards and headings', () => {
    expect(fired(base({ state: state({ questions: [{ ...openQuestion, label: '' }] }) }))).toEqual(['h']);
    const missing = { status: 'missing', missingText: [], explanation: ['a', 'b'], assumptions: [], missingFields: [], eligibilityText: '' };
    expect(fired(base({ state: state({ comparison: missing }) }))).toEqual(['h']);
    expect(fired(base({ panels: ['<div class="x"></div>'] }))).toEqual(['h']);
    expect(fired(base({ panels: ['<div><h2>שאלות שממתינות לנציג</h2></div>'] }))).toEqual(['h']);
    expect(fired(base({ panels: [''] }))).toEqual([]);
  });
});
