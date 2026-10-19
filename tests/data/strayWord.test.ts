import { describe, expect, it } from 'vitest';
import { currentCarClause, resolveCurrentCarDetailed } from '../../src/agent/currentCar';
import { matchCatalogCar } from '../../src/data/carMatch';

describe('a mangled word of a more specific model is never ignored silently', () => {
  it.each(['טויוטה COROLLA ROSS', 'טויוטה COROLLA COSS'])('"%s" offers the Corolla AND the Corolla Cross (never the Corolla alone)', (text) => {
    const m = matchCatalogCar(text);
    expect(m.status).toBe('ambiguous');
    if (m.status === 'ambiguous') expect(m.cars.map((c) => c.id)).toEqual(expect.arrayContaining(['CAR-07', 'CAR-09']));
  });

  it('the plain names are still found directly', () => {
    expect(matchCatalogCar('טויוטה קורולה')).toMatchObject({ status: 'found', car: { id: 'CAR-07' } });
    expect(matchCatalogCar('טויוטה קורולה קרוס')).toMatchObject({ status: 'found', car: { id: 'CAR-09' } });
    expect(matchCatalogCar('קיה SPORTAGE HEV')).toMatchObject({ status: 'found', car: { id: 'CAR-16' } });
  });
});

describe('the current car clause in a long message', () => {
  const MSG =
    'אני מהנדסת תוכנה, משכורת בסיס 20000, פנסיה 6%, קרן השתלמות 2.5%, אני לא יודעת כמה נקודות זיכוי יש לי, בלי ילדים. הרכב שלי כרגע קורולה קרוס 2025 עם השתתפות 300. מה יקרה אם אעבור לקיה נירו?';

  it('is the sentence that names a car, not the first sentence that contains "יש לי"', () => {
    expect(currentCarClause(MSG)).toContain('קורולה קרוס');
    expect(resolveCurrentCarDetailed(MSG)?.fields).toEqual({ kind: 'car', carId: 'CAR-09' });
  });

  it('a decimal point ("2.5%") does not end a sentence', () => {
    expect(currentCarClause('הרכב שלי קורולה קרוס, קרן השתלמות 2.5%')).toContain('קורולה קרוס');
  });
});
