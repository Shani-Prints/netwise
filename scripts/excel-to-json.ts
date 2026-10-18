/**
 * Converts data/challenge-data.xlsx into data/generated/*.json (re-runnable: `pnpm data:generate`).
 * Also resolves each catalogue car's vehicleTypeCode against data/usage-value-2026.csv.
 */
import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import { readUsageCsv } from '../src/data/usageCsv';

const DATA = path.join(process.cwd(), 'data');
const OUT = path.join(DATA, 'generated');

const DRIVE: Record<string, string> = { בנזין: 'petrol', היברידי: 'hybrid', חשמלי: 'electric', 'פלאג-אין': 'plugin' };

function sheetRows(wb: XLSX.WorkBook, name: string): Record<string, unknown>[] {
  const ws = wb.Sheets[name];
  if (!ws) throw new Error(`Missing sheet "${name}"`);
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null });
}
const str = (v: unknown) => String(v ?? '').trim();
const numOf = (v: unknown, what: string) => {
  const n = Number(v);
  if (v === null || v === '' || !Number.isFinite(n)) throw new Error(`Bad number for ${what}: ${String(v)}`);
  return n;
};
const write = (name: string, data: unknown) => {
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`wrote data/generated/${name}`);
};

const wb = XLSX.readFile(path.join(DATA, 'challenge-data.xlsx'));
const usage = readUsageCsv(path.join(DATA, 'usage-value-2026.csv'));
fs.mkdirSync(OUT, { recursive: true });

// ---- catalogue ----
const catalog = sheetRows(wb, 'קטלוג רכבים').map((r) => {
  const id = str(r['מזהה']);
  const groupHe = str(r['קבוצה']);
  const makerCode = str(r['קוד תוצר']);
  const modelCode = str(r['קוד דגם']);
  const registrationYear = numOf(r['שנת רישום'], `${id} year`);
  const usageValue = numOf(r['שווי שימוש חודשי'], `${id} usage`);
  const candidates = usage.filter(
    (u) => u.makerCode === makerCode && u.modelCode === modelCode && u.registrationYear === registrationYear,
  );
  // Several vehicle types may exist (e.g. BYD Atto 3): pick the one whose usage value equals the catalogue's.
  const match = candidates.filter((u) => u.usageValue === usageValue);
  if (match.length !== 1) {
    throw new Error(`${id}: expected exactly 1 dataset row matching usage value ${usageValue}, got ${match.length} of ${candidates.length}`);
  }
  const drive = DRIVE[str(r['הנעה'])];
  if (!drive) throw new Error(`${id}: unknown drive ${str(r['הנעה'])}`);
  return {
    id,
    group: groupHe === 'משפחתי' ? 'family' : groupHe,
    makerName: str(r['תוצר']),
    makerCode,
    modelName: str(r['דגם (כינוי מסחרי)']),
    modelCode,
    modelDescription: str(r['תאור דגם']),
    registrationYear,
    drive,
    listPrice: numOf(r['מחיר מחירון'], `${id} list`),
    usageValue,
    monthlyCost: numOf(r['עלות חודשית לחברה (דמה)'], `${id} cost`),
    defaultParticipation: numOf(r['השתתפות עובד ברירת מחדל (דמה)'], `${id} participation`),
    vehicleTypeCode: match[0]!.vehicleTypeCode,
    ambiguousCandidates: candidates.length,
  };
});
write('catalog.json', catalog);

// ---- occupations ----
const occupations = sheetRows(wb, 'עיסוקים').map((r) => ({
  name: str(r['עיסוק']),
  group: str(r['קבוצת זכאות']),
  carMandatory: str(r['רכב חובה']) === 'כן',
  waiverAllowed: str(r['מותר לוותר']) === 'כן',
  maintenance: numOf(r['אחזקת רכב בוויתור (₪)'], 'maintenance'),
}));
write('occupations.json', occupations);

// ---- sample employees (national IDs deliberately dropped: not needed, data minimisation) ----
const carByModel = new Map(catalog.map((c) => [c.modelName, c.id]));
const sample = sheetRows(wb, 'עובדים לדוגמה').map((r) => {
  const carText = str(r['רכב היום']);
  const carId = carByModel.get(carText);
  const waiver = carText.startsWith('אין');
  if (!carId && !waiver) throw new Error(`Cannot resolve current car "${carText}"`);
  return {
    id: str(r['מזהה']),
    name: str(r['שם']),
    occupation: str(r['עיסוק']),
    group: str(r['קבוצה']),
    base: numOf(r['שכר בסיס'], 'base'),
    commissions: numOf(r['עמלות'], 'commissions'),
    bonus: numOf(r['בונוס'], 'bonus'),
    pensionPct: numOf(r['פנסיה עובד %'], 'pension'),
    studyFundPct: numOf(r['קרן השתלמות עובד %'], 'studyFund'),
    creditPoints: numOf(r['נקודות זיכוי'], 'credit'),
    childrenUnder23: numOf(r['ילדים עד 23'], 'children'),
    currentCar: waiver ? { kind: 'waiver' } : { kind: 'car', carId },
    currentParticipation: numOf(r['השתתפות היום'], 'participation today'),
    question: str(r['השאלה']),
  };
});
write('sample-employees.json', sample);

// ---- reference results ----
const parseOption = (text: string) => {
  if (text.startsWith('ויתור')) return { kind: 'waiver', maintenance: Number(/(\d[\d,]*)\s*₪/.exec(text)?.[1]?.replace(/,/g, '')) };
  const name = text.replace(/\s*\(\d{4}\)\s*$/, '');
  const carId = carByModel.get(name);
  if (!carId) throw new Error(`Cannot resolve reference option "${text}"`);
  return { kind: 'car', carId };
};
const reference = sheetRows(wb, 'חישובים').map((r) => ({
  employeeId: str(r['מזהה']),
  today: parseOption(str(r['היום'])),
  alternative: parseOption(str(r['החלופה'])),
  eligible: str(r['זכאות']) === 'כן',
  reason: str(r['סיבה']),
  netToday: numOf(r['נטו היום'], 'netToday'),
  netAlternative: numOf(r['נטו בחלופה'], 'netAlt'),
  difference: numOf(r['הפרש'], 'diff'),
  taxToday: numOf(r['מס היום'], 'taxToday'),
  taxAlternative: numOf(r['מס בחלופה'], 'taxAlt'),
  niHealthToday: numOf(r['ביטוח לאומי+בריאות היום'], 'niToday'),
  niHealthAlternative: numOf(r['ביטוח לאומי+בריאות בחלופה'], 'niAlt'),
  evGrossUp: numOf(r['החזר חשמל ברוטו'], 'ev'),
  familyShare: numOf(r['חלק העובד במסלול המשפחתי'], 'family'),
  explanation: str(r['למה']),
}));
write('reference-results.json', reference);
