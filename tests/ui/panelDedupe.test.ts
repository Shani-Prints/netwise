import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { he } from '../../src/components/car-advisor/content/he';
import type { ApiComparison, ApiComponents } from '../../src/components/car-advisor/contract/apiTypes';
import { ComparisonPanel } from '../../src/components/car-advisor/messages/ComparisonPanel';

const zero: ApiComponents = {
  gross: 0, taxableBase: 0, usageValue: 0, maintenance: 0, evGrossUp: 0, tax: 0, nationalInsurance: 0, health: 0, pension: 0,
  studyFund: 0, participation: 0, familyShare: 0, net: 0,
};
const scenario = (net: number) => ({ label: 'x', components: { ...zero, net }, costVsBudget: null });
const HEADLINE = 'בחלופה "קיה EV3 (2025)" הנטו החודשי המוערך הוא 11,779 ₪ לעומת 11,032 ₪ היום – עלייה של 747 ₪.';
const REASONS = 'שווי השימוש משתנה מ-3,350 ל-2,690 ₪.';
const ok = {
  status: 'ok',
  alternativeLabel: 'קיה EV3 (2025)',
  eligible: true,
  eligibilityText: '',
  today: scenario(11032),
  alternative: scenario(11779),
  difference: 747,
  explanation: [HEADLINE, REASONS],
  assumptions: [],
  missingFields: [],
  missingText: [],
} as unknown as ApiComparison;
const html = (c: ApiComparison) => renderToStaticMarkup(createElement(ComparisonPanel, { comparison: c }));
const count = (markup: string, text: string) => markup.split(text).length - 1;

describe('the result panel does not repeat itself or the chat bubble', () => {
  const markup = html(ok);

  it('the headline sentence (said in the bubble) is not in the panel; the reasons line is', () => {
    expect(markup).not.toContain('הנטו החודשי המוערך הוא');
    expect(markup).toContain(REASONS);
  });

  it('the table title appears exactly once', () => {
    const title = he.api.comparison.caption.replace('{alternative}', 'קיה EV3 (2025)');
    expect(count(markup, title)).toBe(1);
    expect(count(markup, he.api.comparison.title)).toBe(1);
  });

  it('without a table (data missing) the title is shown once and the explanation is kept in full', () => {
    const missing = { ...ok, status: 'missing', alternative: undefined, difference: undefined, missingText: ['אחוז פנסיה'], explanation: ['חסר מידע כדי לחשב: אחוז פנסיה.', 'לכן לא הצגתי נטו.'] } as unknown as ApiComparison;
    const m = html(missing);
    const title = he.api.comparison.caption.replace('{alternative}', 'קיה EV3 (2025)');
    expect(count(m, title)).toBe(1);
    expect(m).toContain('חסר מידע כדי לחשב: אחוז פנסיה.');
  });
});
