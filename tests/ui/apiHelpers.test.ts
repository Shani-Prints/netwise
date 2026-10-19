import { describe, expect, it } from 'vitest';
import { parseTypedAnswer } from '../../src/app/rep/answerInput';
import { fill } from '../../src/components/car-advisor/content/fill';
import { ApiError } from '../../src/components/car-advisor/contract/apiClient';
import type { ApiAnswerSpec, ApiComparison, ApiComponents } from '../../src/components/car-advisor/contract/apiTypes';
import {
  comparisonRows,
  differenceText,
  formatShekel,
} from '../../src/components/car-advisor/messages/comparisonFormat';
import { messageWasNotStored } from '../../src/components/car-advisor/useApiChatController';

const zero: ApiComponents = {
  gross: 0,
  taxableBase: 0,
  usageValue: 0,
  maintenance: 0,
  evGrossUp: 0,
  tax: 0,
  nationalInsurance: 0,
  health: 0,
  pension: 0,
  studyFund: 0,
  participation: 0,
  familyShare: 0,
  net: 0,
};

function comparison(today: Partial<ApiComponents>, alternative: Partial<ApiComponents>): ApiComparison {
  return {
    status: 'ok',
    today: { components: { ...zero, ...today } },
    alternative: { components: { ...zero, ...alternative } },
  } as unknown as ApiComparison;
}

describe('comparison formatting', () => {
  it('formats whole shekels with a real minus sign', () => {
    expect(formatShekel(12345)).toContain('12');
    expect(formatShekel(-500).startsWith('−')).toBe(true);
    expect(formatShekel(0)).toBe('₪0');
  });

  it('leaves out rows that are zero in both columns, but always keeps the net', () => {
    const rows = comparisonRows(comparison({ usageValue: 100, net: 9000 }, { tax: 50, net: 9100 }));
    expect(rows.map((row) => row.key)).toEqual(['usageValue', 'tax', 'net']);
    expect(rows.at(-1)?.strong).toBe(true);
    expect(comparisonRows(comparison({}, {})).map((row) => row.key)).toEqual(['net']);
  });

  it('returns no rows when a column is missing', () => {
    expect(comparisonRows({ status: 'missing', today: null, alternative: null } as unknown as ApiComparison)).toEqual([]);
  });

  it('words the difference without a double minus', () => {
    expect(differenceText(300, fill)).toContain('עלייה');
    const down = differenceText(-300, fill);
    expect(down).toContain('ירידה');
    expect(down).not.toContain('−');
    expect(differenceText(0, fill)).toContain('אין שינוי');
  });
});

describe('typed answers follow the answerSpec', () => {
  const integer: ApiAnswerSpec = { type: 'number', unit: 'percent', min: 0, max: 100, integer: true };
  const choice: ApiAnswerSpec = {
    type: 'choice',
    options: [
      { value: 'yes', label: 'כן' },
      { value: 'no', label: 'לא' },
    ],
  };

  it('accepts a number inside the range and rejects the rest', () => {
    expect(parseTypedAnswer(integer, ' 50 ')).toBe('50');
    expect(parseTypedAnswer(integer, '101')).toBeNull();
    expect(parseTypedAnswer(integer, '-1')).toBeNull();
    expect(parseTypedAnswer(integer, '5.5')).toBeNull();
    expect(parseTypedAnswer(integer, 'abc')).toBeNull();
    expect(parseTypedAnswer(integer, '')).toBeNull();
    expect(parseTypedAnswer({ ...integer, integer: false }, '5.5')).toBe('5.5');
  });

  it('accepts only one of the offered options', () => {
    expect(parseTypedAnswer(choice, 'yes')).toBe('yes');
    expect(parseTypedAnswer(choice, 'maybe')).toBeNull();
  });
});

describe('after which errors the typed message goes back into the composer', () => {
  it('is restored only when the server certainly did not store it', () => {
    for (const status of [400, 401, 403, 429]) expect(messageWasNotStored(new ApiError(status, 'x'))).toBe(true);
    // after a network failure the server may have stored the message: it is not put back (that would send it twice)
    for (const status of [0, 500, 503]) expect(messageWasNotStored(new ApiError(status, 'x'))).toBe(false);
    expect(messageWasNotStored(new Error('boom'))).toBe(false);
  });
});
