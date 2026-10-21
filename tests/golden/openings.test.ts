import { describe, expect, it } from 'vitest';
import { openingAcks, repeatedOpenings } from './openings';

describe('the opening-acknowledgment check itself', () => {
  it('flags two consecutive messages that open with the same acknowledgment (negative control)', () => {
    expect(repeatedOpenings(['מעולה, תודה. מה העיסוק?', 'מעולה, תודה. כמה ילדים יש?'])).toHaveLength(1);
    expect(repeatedOpenings(['תודה, רשמתי. מה הבונוס?', 'רשמתי, תודה. מה הפנסיה?'])).toHaveLength(1);
    expect(repeatedOpenings(['בכיף! נתחיל', 'ביניים', 'בכיף! שוב'])).toEqual([]);
  });

  it('accepts varied openings and messages without an acknowledgment', () => {
    expect(repeatedOpenings(['היי, אשמח לעזור.', 'הנחתי שקבוצת הזכאות היא ג.', 'רשמתי. מה הבונוס?', 'לאיזה רכב נשווה?'])).toEqual([]);
    expect(openingAcks('הנציג עדכן את אחוז הפנסיה.')).toEqual([]);
  });
});
