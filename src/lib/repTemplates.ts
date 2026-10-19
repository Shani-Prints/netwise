/**
 * EVERY employee-facing sentence about a representative's answer is a fixed template from this file. Nothing the
 * representative wrote is ever copied into them: a template only gets a field label or a car label that the SERVER knows.
 * The role is always called "הנציג". Tone: short and warm, and no sentence depends on grammatical agreement with a value.
 */

/** The employee asked about her question: one fixed sentence per stored status. */
export const STATUS_TEXT = {
  open: 'שלחתי שאלה לנציג והיא עדיין ממתינה לתשובה.',
  clarification: 'ביקשתי מהנציג הבהרה, והשאלה ממתינה לתשובה.',
  checking: 'הנציג בודק את השאלה ויחזור עם תשובה.',
  answered: 'הנציג ענה על השאלה והתשובה טופלה.',
  unresolved: 'לא התקבלה מהנציג תשובה ברורה, ולכן הנתון לא זמין כרגע.',
  none: 'לא נשלחה שאלה לנציג.',
} as const;
export type QuestionStatus = keyof typeof STATUS_TEXT;

/** Row 3: no matching record. No value is applied. */
export const EMPLOYEE_NOT_FOUND_TEXT =
  'הנציג בדק ולא מצא רשומה שמתאימה לפרטים שלך, ולכן אי אפשר לחשב את ההשוואה כרגע. כדאי לבדוק את הפרטים מול מי שמטפל בענייני שכר בחברה.';

/** Row 4: the value is not available at all. */
export const valueUnavailableText = (label: string): string =>
  `הנציג השיב שהנתון "${label}" לא זמין, ולכן אי אפשר לחשב את ההשוואה שתלויה בו. לא אשאל אותך שוב עליו.`;

/** Row 5: the representative is still checking (the question stays open). */
export const WILL_CHECK_LATER_TEXT = STATUS_TEXT.checking + ' אין צורך לשלוח שוב.';

/** Row 6: the arrangement for a car above the budget. */
export const overBudgetApprovedText = (carLabel: string): string =>
  `הנציג השיב שההסדר לרכב "${carLabel}" אושר. החישוב להסדר הזה עדיין לא נתמך במערכת, ולכן לא הצגתי נטו לרכב הזה.`;
export const overBudgetDeniedText = (carLabel: string): string =>
  `הנציג השיב שההסדר לרכב "${carLabel}" לא אושר, ולכן אי אפשר לבחור ברכב הזה.`;

/** Row 7: the representative says this is handled elsewhere. */
export const REFER_ELSEWHERE_TEXT =
  'הנציג השיב שהוא לא יכול לטפל בנתון הזה, ושכדאי לפנות לגורם אחר בחברה. לא אשאל אותך שוב עליו.';

/** Row 8: a follow-up question was sent to the representative. */
export const clarificationRequestedText = (label: string): string =>
  `ביקשתי מהנציג הבהרה לגבי הנתון "${label}". אעדכן אותך כשתהיה תשובה.`;

/** Row 9: after the cap of follow-ups. */
export const unresolvedFinalText = (label: string): string =>
  `לא הצלחנו לקבל מהנציג תשובה ברורה לגבי הנתון "${label}", ולכן אי אפשר לחשב את ההשוואה שתלויה בו. לא אשאל אותך שוב עליו.`;

/** Row 8: the follow-up question the representative sees (it quotes the question it clarifies, never the old answer). */
export const followUpQuestionText = (originalQuestionText: string): string =>
  `הבהרה לשאלה קודמת: ${originalQuestionText} התשובה שנשלחה לא התאימה לשאלה (לא הובנה, לא בטווח או לא ברורה). נא להשיב שוב לפי הסוג שמתבקש.`;

/** Max follow-ups per original question (row 8/9). */
export const MAX_FOLLOW_UPS = 2;
/** Max interpretation attempts that failed because of an invalid model answer or a timeout (row 12). */
export const MAX_INTERPRET_ATTEMPTS = 3;

/** A comparison input that will not become available (shown with the Hebrew reason next to the missing fields). */
export const gapReasonText = (label: string): string =>
  `הנתון "${label}" לא זמין, ולכן אי אפשר לחשב את ההשוואה שתלויה בו.`;

/**
 * The system message after a representative's answer was written to the profile. The value is passed in already formatted
 * (percent, points, shekels ...), so the sentence never depends on grammatical agreement with it.
 * `quoted` is for text values (a group letter, an occupation, a car): they are shown in quotes.
 */
export const repUpdatedText = (label: string, value: string, quoted: boolean): string =>
  `הנציג עדכן את הנתון "${label}" ל${quoted ? `"${value}"` : `-${value}`}. הערך נשמר בפרופיל שלך (הוזן על ידי נציג) ואפשר לתקן אותו בכל שלב.`;

/** One fact of a merged notice: "label" ל-value. */
export const repUpdatedPart = (label: string, value: string, quoted: boolean): string => `"${label}" ל${quoted ? `"${value}"` : `-${value}`}`;

/** ONE notice when several representative answers are applied together: it lists the fields. */
export const repUpdatedManyText = (parts: string[]): string =>
  `הנציג עדכן כמה נתונים: ${parts.join('; ')}. הערכים נשמרו בפרופיל שלך (הוזנו על ידי נציג) ואפשר לתקן אותם בכל שלב.`;

/** The participation in the new car (kept on the conversation, not on the profile). */
export const repParticipationUpdatedText = (carLabel: string, value: string): string =>
  `הנציג עדכן את הנתון "ההשתתפות ברכב ${carLabel}" ל-${value}. החישוב עודכן בהתאם.`;

/** The representative answered a question about a car above its group budget (the engine has no rule for it yet). */
export const repBudgetPolicyText = (carLabel: string, policyLabel: string): string =>
  `הנציג השיב לגבי הרכב "${carLabel}": ${policyLabel}. הכללים במערכת עדיין לא כוללים הסדר לפער מעל התקציב, ולכן לא הצגתי נטו לרכב הזה.`;

/** A rejected typed answer: the question stays open. */
export const REP_ANSWER_REJECTED_TEXT = 'הנציג ניסה להשיב, אבל התשובה לא הייתה תקינה. השאלה עדיין פתוחה.';

const bullets = (items: string[]): string => items.map((i) => `- ${i}`).join('\n');

/** The current car was not found in the catalogue (attempts 1 and 2): friendly, with same-maker candidates if the server has some. */
/** Shown under a car list that was cut to its first MAX_CAR_CANDIDATES rows. */
export const MORE_OPTIONS_TEXT = 'יש עוד אפשרויות, אפשר לדייק את הדגם או השנה.';

export const carNotFoundText = (candidates: string[], more = false): string =>
  candidates.length > 0
    ? `לא מצאתי בדיוק את הרכב הזה בקטלוג של החברה. אלה הרכבים של אותו יצרן:\n${bullets(candidates)}${more ? `\n${MORE_OPTIONS_TEXT}` : ''}\nאפשר לבחור אחד מהם, או לכתוב שוב את היצרן והדגם.`
    : 'לא מצאתי את הרכב הזה בקטלוג של החברה. אפשר לכתוב שוב את היצרן והדגם?';

/** The 3rd failed attempt: the server really sent the question to the representative in this same turn. */
export const CAR_NOT_FOUND_SENT_TEXT =
  'לא הצלחתי למצוא את הרכב בקטלוג של החברה, ולכן שלחתי שאלה לנציג שיעזור לזהות אותו. בינתיים אפשר להמשיך עם שאר הפרטים.';

/** The car the employee wants to move to is not on the list for her group: the eligible options come from the rules. */
export const altNotOnListText = (options: string[]): string =>
  options.length > 0
    ? `הרכב שביקשת לא ברשימה של החברה לקבוצה שלך. אלה הרכבים שמתאימים לך:\n${bullets(options)}\nבאיזה מהם תרצו להשוות?`
    : 'הרכב שביקשת לא נמצא ברשימת הרכבים של החברה. אפשר לכתוב שוב את היצרן והדגם?';

/** Assumption line of a comparison: the current car is the catalogue row and the employee did not state its year. */
export const currentCarYearAssumptionText = (year: number, label: string): string =>
  `הנחתי שנת רישום ${year} עבור ${label} לפי הקטלוג. אם זו לא השנה הנכונה, כתבי לי את השנה.`;

/** The description fits several cars (or one only through a typo): the options come from the catalogue. */
export const pickCarText = (options: string[], more = false): string =>
  `לא ברור לי לאיזה רכב התכוונת. אלה האפשרויות:\n${bullets(options)}${more ? `\n${MORE_OPTIONS_TEXT}` : ''}\nאיזה מהם?`;

/** The occupation she wrote fits several rows of the occupations table (or one only through a typo). */
export const pickOccupationText = (options: string[]): string =>
  `לא ברור לי מה העיסוק שלך. אלה העיסוקים הקרובים בטבלה:
${bullets(options)}
איזה מהם?`;

/** After a refusal: what she can choose. */
export const eligibleOptionsText = (options: string[]): string =>
  `אלה הרכבים שמתאימים לקבוצה שלך:\n${bullets(options)}\nבאיזה מהם תרצו להשוות?`;

/** Added to ANY final text when the server opened a question in this turn and the text does not say so. */
export const repQuestionSentText = (labels: string[]): string => {
  const list = labels.length <= 1 ? (labels[0] ?? '') : `${labels.slice(0, -1).join(', ')} ו${labels[labels.length - 1]}`;
  return `חסר לי מידע לגבי ${list}, ולכן שלחתי פנייה לנציג. אעדכן אותך כשתהיה תשובה.`;
};
