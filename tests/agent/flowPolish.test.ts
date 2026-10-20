import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { askBatchFields, askBatchLabels } from '../../src/agent/askNext';
import { resetChatRateLimit } from '../../src/agent/chatHandler';
import { ensureSingleResult, isHeadlineOnly, PANEL_POINTER_HE, resultSummaryText, updatedLabelsOf } from '../../src/agent/flowText';
import { guardResponse } from '../../src/agent/guard';
import { buildSystemPrompt } from '../../src/agent/prompt';
import { newCollector } from '../../src/agent/tools';
import { repParticipationUpdatedText, repUpdatedManyText, repUpdatedPart, repUpdatedText } from '../../src/lib/repTemplates';
import { freshRepo, restoreEnv, setupEnv } from '../api/harness';
import { call, chat, fake, groupGimelEmployee, provider, say } from './fakes';

beforeEach(() => {
  setupEnv();
  freshRepo();
  resetChatRateLimit();
});
afterEach(() => restoreEnv());

describe('questions come in batches of 2-3 related fields, in a logical order', () => {
  it('nothing known: occupation and base salary first (the group is derived, never asked)', () => {
    const all = ['group', 'occupation', 'occupationDetails', 'base', 'commissions', 'bonus', 'pensionPct', 'studyFundPct', 'creditPoints', 'childrenUnder23', 'currentCar', 'currentParticipation'];
    expect(askBatchFields(all)).toEqual(['occupation', 'base']);
  });

  it('then the pay components, then the deductions, then the children and the car', () => {
    expect(askBatchFields(['commissions', 'bonus', 'pensionPct', 'studyFundPct', 'creditPoints', 'childrenUnder23', 'currentCar'])).toEqual(['commissions', 'bonus']);
    expect(askBatchFields(['pensionPct', 'studyFundPct', 'creditPoints', 'childrenUnder23', 'currentCar'])).toEqual(['pensionPct', 'studyFundPct', 'creditPoints']);
    expect(askBatchFields(['childrenUnder23', 'currentCar', 'currentParticipation'])).toEqual(['childrenUnder23', 'currentCar', 'currentParticipation']);
  });

  it('a lone missing field is topped up from the next group, never above 3', () => {
    expect(askBatchFields(['bonus', 'pensionPct', 'studyFundPct', 'creditPoints'])).toEqual(['bonus', 'pensionPct']);
    expect(askBatchFields(['creditPoints', 'childrenUnder23', 'currentCar', 'currentParticipation'])).toEqual(['creditPoints', 'childrenUnder23']);
    for (const missing of [['bonus', 'pensionPct', 'studyFundPct'], ['occupation', 'commissions', 'bonus', 'pensionPct']]) {
      expect(askBatchFields(missing).length).toBeLessThanOrEqual(3);
    }
  });

  it('only fields that are missing are returned (known fields never appear)', () => {
    expect(askBatchFields(['bonus'])).toEqual(['bonus']);
    expect(askBatchFields([])).toEqual([]);
    expect(askBatchLabels(['pensionPct', 'creditPoints'])).toEqual(['אחוז פנסיה של העובד', 'נקודות זיכוי']);
  });
});

describe('the prompt: short opening, no upload, batches', () => {
  const prompt = buildSystemPrompt('', false);
  it('asks only occupation and base salary first and never offers an upload', () => {
    expect(prompt).toContain('OPENING');
    expect(prompt).toContain('exactly two things together: the occupation (job role) and the monthly base salary');
    expect(prompt).toContain('Never suggest uploading a payslip');
  });
  it('stays within a size budget (guards against the prompt growing back)', () => {
    expect(prompt.length).toBeLessThan(17_000);
  });
});

// ---- the result appears once ----
const okView = {
  status: 'ok' as const,
  alternativeLabel: 'KIA EV3 (2025)',
  today: { components: { net: 11032 } },
  alternative: { components: { net: 11779 } },
  difference: 747,
  explanation: [
    'בחלופה "KIA EV3 (2025)" הנטו החודשי המוערך הוא 11,779 ₪ לעומת 11,032 ₪ היום – עלייה של 747 ₪.',
    'שווי השימוש משתנה מ-3,350 ל-2,690 ₪ · החזר חשמל: 250 ₪ נטו בדיוק (מגולם, כ-473 ₪ ברוטו).',
  ],
  assumptions: ['השתתפות העובד ברכב החדש (300 ₪) נלקחה מברירת המחדל בקטלוג (נתוני הדגמה).'],
};
const collectorWith = (view: unknown) => {
  const c = newCollector();
  c.lastView = view as never;
  c.results.push({
    tool: 'calculate_comparison',
    output: { status: 'ok', todayNet: 11032, alternativeNet: 11779, difference: 747, explanation: okView.explanation, assumptions: okView.assumptions },
  });
  return c;
};

describe('single result block: headline in the bubble, breakdown only in the panel', () => {
  it('the summary is one sentence with the three headline numbers and the pointer, nothing else', () => {
    const s = resultSummaryText(okView as never);
    expect(s).toContain('11,779');
    expect(s).toContain('11,032');
    expect(s).toContain('747');
    expect(s).toContain(PANEL_POINTER_HE);
    expect(s).not.toContain('שווי השימוש');
    expect(s).not.toContain('250');
    expect(s.split('\n')).toHaveLength(1);
  });

  it('a model text that repeats the breakdown is replaced by the summary', () => {
    const long = `הנה ההשוואה: היום נטו 11,032 ₪, עם הרכב החדש 11,779 ₪. למה? ${okView.explanation[1]} ${okView.assumptions[0]}`;
    expect(ensureSingleResult(long, collectorWith(okView))).toBe(resultSummaryText(okView as never));
  });

  it('a model text with another amount (tax, refund ...) is replaced too', () => {
    const text = 'היום נטו 11,032 ₪ ועם הרכב החדש 11,779 ₪. יש החזר חשמל של 250 ₪.';
    expect(ensureSingleResult(text, collectorWith(okView))).toBe(resultSummaryText(okView as never));
  });

  it('a short model text with only the headline numbers is kept, and the pointer is added once', () => {
    const own = 'עם הרכב החדש הנטו המוערך הוא 11,779 ₪ לעומת 11,032 ₪ היום.';
    const out = ensureSingleResult(own, collectorWith(okView));
    expect(out).toBe(`${own} ${PANEL_POINTER_HE}`);
    expect(ensureSingleResult(out, collectorWith(okView))).toBe(out);
    expect(isHeadlineOnly(own, okView as never)).toBe(true);
  });

  it('nothing changes without a numeric comparison in this turn', () => {
    expect(ensureSingleResult('תודה, מה אחוז הפנסיה?', newCollector())).toBe('תודה, מה אחוז הפנסיה?');
    expect(ensureSingleResult('חסר מידע', collectorWith({ ...okView, status: 'missing' }))).toBe('חסר מידע');
  });

  it('the guard approves the summary (all numbers come from the tool result)', () => {
    expect(guardResponse(resultSummaryText(okView as never), collectorWith(okView), [])).toEqual({ ok: true });
  });

  it('end to end: no breakdown line or assumption of the panel is repeated in the bubble, whatever the model writes', async () => {
    const e = await groupGimelEmployee();
    const model = fake(
      call('calculate_comparison', { alternative: 'CAR-10' }),
      say('למה? שווי השימוש משתנה, יש החזר חשמל, והשתתפות העובד 300 ₪. הנטו 11,693 ₪.'),
    );
    const r = await chat(e, 'תשווה לאטו 3', { providers: [provider(model)] });
    expect(r.status).toBe(200);
    const bubble: string = r.body.assistantText;
    const panel = r.body.comparison;
    expect(panel.status).toBe('ok');
    for (const line of [...panel.explanation, ...panel.assumptions]) expect(bubble, line).not.toContain(String(line).replace(/[.\s]+$/, ''));
    expect(bubble).toContain(PANEL_POINTER_HE);
    expect(bubble.split('\n')).toHaveLength(1);
    // the numbers in the bubble are only the headline ones
    const shown = [...bubble.matchAll(/\d[\d,]*/g)].map((m) => Number(m[0].replace(/,/g, '')));
    const headline = [panel.today.components.net, panel.alternative.components.net, Math.abs(panel.difference)];
    const catalogDigits = [...String(panel.alternativeLabel).matchAll(/\d+/g)].map((m) => Number(m[0]));
    for (const n of shown) expect([...headline, ...catalogDigits], `number ${n} in the bubble`).toContain(n);
  });
});

describe('the bridge line after a representative answer', () => {
  it('reads the labels from the fixed notices', () => {
    expect(updatedLabelsOf([repUpdatedText('אחוז הפנסיה', '6%', false)])).toEqual(['אחוז הפנסיה']);
    expect(updatedLabelsOf([repUpdatedText('קבוצת הזכאות', 'ג', true)])).toEqual(['קבוצת הזכאות']);
    expect(updatedLabelsOf([repParticipationUpdatedText('KIA EV3 (2025)', '350 ₪')])).toEqual(['ההשתתפות ברכב KIA EV3 (2025)']);
    const many = repUpdatedManyText([repUpdatedPart('נקודות זיכוי', '2.75', false), repUpdatedPart('העיסוק', 'X', true)]);
    expect(updatedLabelsOf([many])).toEqual(['נקודות זיכוי', 'העיסוק']);
  });

  it('ignores system notices that are not updates', () => {
    expect(updatedLabelsOf(['הנציג בדק ולא מצא רשומה שמתאימה לפרטים, ולכן אי אפשר לחשב.'])).toEqual([]);
  });
});
