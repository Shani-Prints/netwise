import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { he } from '../../src/components/car-advisor/content/he';
import type { ApiComparison, ApiComponents } from '../../src/components/car-advisor/contract/apiTypes';
import { ComparisonPanel } from '../../src/components/car-advisor/messages/ComparisonPanel';
import { ComparisonSummary } from '../../src/components/car-advisor/messages/ComparisonSummary';
import { InlineComparison } from '../../src/components/car-advisor/messages/InlineComparison';
import { buildTimeline } from '../../src/components/car-advisor/timeline';

const zero: ApiComponents = {
  gross: 0, taxableBase: 0, usageValue: 0, maintenance: 0, evGrossUp: 0, tax: 0, nationalInsurance: 0, health: 0, pension: 0,
  studyFund: 0, participation: 0, familyShare: 0, net: 0,
};
const scenario = (label: string, over: Partial<ApiComponents>) => ({ label, components: { ...zero, ...over }, costVsBudget: null });
const ok: ApiComparison = {
  status: 'ok',
  alternativeRef: { kind: 'car', carId: 'CAR-X' },
  alternativeLabel: 'דגם בדוי ב (2025)',
  eligible: true,
  eligibilityText: 'הרכב מהקבוצה',
  today: scenario('דגם בדוי א (2024)', { usageValue: 2100, tax: 3300, pension: 700, net: 12345 }),
  alternative: scenario('דגם בדוי ב (2025)', { usageValue: 2500, tax: 3600, pension: 700, net: 11876 }),
  difference: -469,
  explanation: ['שורת כותרת', 'שורת הסבר'],
  assumptions: ['הנחה בדויה'],
  missingFields: [],
  missingText: [],
  payslipEntered: ['שכר בסיס'],
  representativeEntered: [{ field: 'pensionPct', label: 'אחוז פנסיה' }],
};
const numbers = (html: string) => (html.replace(/<[^>]*>/g, ' ').match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[,.]$/, ''));
const actions = { waiverAllowed: false, disabled: false, onSend: () => {} };
const S = he.api.comparison.summary;

describe('comparison summary', () => {
  const summary = renderToStaticMarkup(createElement(ComparisonSummary, { comparison: ok, date: '22.10.2026' }));
  const card = renderToStaticMarkup(createElement(ComparisonPanel, { comparison: ok }));

  it('shows the same amounts as the card and no extra numbers', () => {
    for (const n of ['12,345', '11,876', '469', '2,100', '2,500', '3,300', '3,600']) {
      expect(summary).toContain(n);
      expect(card).toContain(n);
    }
    const cardNumbers = new Set(numbers(card));
    const extra = numbers(summary).filter((n) => !cardNumbers.has(n) && !['22.10.2026', '2025', '2024', '22', '10', '2026'].includes(n));
    expect(extra).toEqual([]);
  });

  it('carries the cars, the date, the assumptions, the source labels and the estimate sentences', () => {
    for (const text of [ok.today!.label, ok.alternativeLabel, '22.10.2026', 'הנחה בדויה', 'שכר בסיס', 'אחוז פנסיה', he.api.comparison.fromPayslipTitle, he.api.comparison.enteredByRepTitle, S.sourceEmployee, S.disclaimer, he.api.comparison.estimateNote]) {
      expect(summary).toContain(text);
    }
  });

  it('the save button is under an ok latest comparison only', () => {
    const latest = renderToStaticMarkup(createElement(InlineComparison, { comparison: ok, collapsed: false, onToggle: () => {}, actions }));
    expect(latest).toContain(S.button);
    const older = renderToStaticMarkup(createElement(InlineComparison, { comparison: ok, collapsed: false, onToggle: () => {} }));
    expect(older).not.toContain(S.button);
    const collapsed = renderToStaticMarkup(createElement(InlineComparison, { comparison: ok, collapsed: true, onToggle: () => {} }));
    expect(collapsed).not.toContain(S.button);
  });

  it('no button when the comparison is not ok', () => {
    for (const status of ['missing', 'ineligible'] as const) {
      const html = renderToStaticMarkup(createElement(InlineComparison, { comparison: { ...ok, status }, collapsed: false, onToggle: () => {}, actions }));
      expect(html).not.toContain(S.button);
      expect(html).toContain(he.api.comparison.anotherCar);
    }
  });

  it('in the timeline only the latest comparison gets the action row', () => {
    const m = (id: string) => ({ id, role: 'assistant' as const, content: id });
    const items = buildTimeline({ messages: [m('a'), m('b')], comparisons: [{ messageId: 'a', comparison: ok }, { messageId: 'b', comparison: ok }], comparison: null, carChoices: null });
    expect(items.filter((i) => i.kind === 'comparison').map((i) => i.kind === 'comparison' && i.latest)).toEqual([false, true]);
  });
});
