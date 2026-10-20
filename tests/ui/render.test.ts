import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { he } from '../../src/components/car-advisor/content/he';
import type { ApiComparison, ApiComponents } from '../../src/components/car-advisor/contract/apiTypes';
import { ComparisonPanel } from '../../src/components/car-advisor/messages/ComparisonPanel';
import { QuestionsCard } from '../../src/components/car-advisor/messages/QuestionsCard';

const zero: ApiComponents = {
  gross: 0, taxableBase: 0, usageValue: 0, maintenance: 0, evGrossUp: 0, tax: 0, nationalInsurance: 0, health: 0, pension: 0,
  studyFund: 0, participation: 0, familyShare: 0, net: 0,
};
const scenario = (net: number) => ({ label: 'x', components: { ...zero, net }, costVsBudget: null });
const base = { alternativeLabel: 'קיה NIRO (2025)', explanation: ['שורה א', 'שורה ב'], assumptions: [], missingFields: [], missingText: [] };
const html = (c: Partial<ApiComparison>) => renderToStaticMarkup(createElement(ComparisonPanel, { comparison: { ...base, ...c } as ApiComparison }));
const c18 = he.api.comparison;

/** Every title that introduces a list or a line must have something after it before the block ends. */
function expectNoEmptyTitles(markup: string) {
  for (const title of [c18.missingTitle, c18.ineligibleTitle, c18.unavailableTitle, c18.assumptionsTitle, c18.enteredByRepTitle, he.api.questions.title]) {
    const at = markup.indexOf(`>${title}</`);
    if (at < 0) continue;
    const after = markup.slice(at + title.length + 2).replace(/^<\/(?:p|h2)>/, '');
    expect(after.startsWith('</div>') || after === '', `the title "${title}" has nothing under it`).toBe(false);
  }
}

describe('item 4: no empty heading', () => {
  it('the questions card is not rendered at all when there are no open questions', () => {
    expect(renderToStaticMarkup(createElement(QuestionsCard, { questions: [] }))).toBe('');
  });

  it('the questions card shows labels only (never a question text) and has content under its heading', () => {
    const markup = renderToStaticMarkup(
      createElement(QuestionsCard, { questions: [{ id: '1', kind: 'profile_field_unknown', field: 'creditPoints', label: 'נקודות הזיכוי', status: 'open', createdAt: '', answeredAt: null }] }),
    );
    expect(markup).toContain('נקודות הזיכוי');
    expect(markup).toContain(he.api.questions.sent);
    expectNoEmptyTitles(markup);
  });

  it('a "missing" comparison with no reasons and no today net has no "חסר מידע" heading', () => {
    const markup = html({ status: 'missing', eligible: null, eligibilityText: '', pendingQuestionId: 'q1' });
    expect(markup).not.toContain(c18.missingTitle);
    expect(markup).toContain(c18.waitingForRep);
  });

  it('every state of the comparison panel has content under every title', () => {
    const states: Partial<ApiComparison>[] = [
      { status: 'ok', eligible: true, eligibilityText: 'הרכב מהקבוצה שלך', today: scenario(10000), alternative: scenario(10100), difference: 100, assumptions: ['הנחה'] },
      { status: 'missing', eligible: null, eligibilityText: '', today: scenario(10000), missingText: ['עיסוק'], pendingQuestionId: 'q1' },
      { status: 'missing', eligible: null, eligibilityText: '', missingText: ['עיסוק'] },
      { status: 'missing', eligible: null, eligibilityText: '', unavailableText: ['אין נתון'] },
      { status: 'ineligible', eligible: false, eligibilityText: 'אין זכאות' },
      { status: 'ineligible', eligible: false, eligibilityText: '' },
      { status: 'ok', eligible: true, eligibilityText: '', today: scenario(1), alternative: scenario(2), representativeEntered: [{ field: 'pensionPct', label: 'פנסיה' }] },
    ];
    for (const s of states) expectNoEmptyTitles(html(s));
  });
});

describe('item 8: the engine eligibility text is shown in the comparison', () => {
  it('shown for an eligible alternative, exactly as the server wrote it', () => {
    const markup = html({ status: 'ok', eligible: true, eligibilityText: 'הרכב מהקבוצה שלך או מקבוצה נמוכה ממנה', today: scenario(10000), alternative: scenario(10100), difference: 100 });
    expect(markup).toContain(c18.eligibilityLabel);
    expect(markup).toContain('הרכב מהקבוצה שלך או מקבוצה נמוכה ממנה');
  });

  it('not shown when the server could not decide (nothing is computed in the UI) and not twice when ineligible', () => {
    expect(html({ status: 'missing', eligible: null, eligibilityText: 'לא ניתן לקבוע זכאות עד להשלמת המידע החסר', missingText: ['עיסוק'] })).not.toContain('לא ניתן לקבוע זכאות');
    const refused = html({ status: 'ineligible', eligible: false, eligibilityText: 'אין זכאות כי…' });
    expect(refused.split('אין זכאות כי…')).toHaveLength(2);
  });

  it('server text is rendered as text, never as markup', () => {
    const markup = html({ status: 'ok', eligible: true, eligibilityText: '<img src=x onerror=alert(1)>', today: scenario(1), alternative: scenario(2), difference: 1 });
    expect(markup).not.toContain('<img');
    expect(markup).toContain('&lt;img');
  });
});
