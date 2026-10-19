# NetWise API contract for the UI

Short reference for the employee screen and the representative screen. All bodies are JSON (`content-type: application/json`).
The identity and the role always come from the signed session cookie (`nw_session`, HttpOnly). Nothing in a body, a query
string or a header can set them.

## Rules the UI must follow

1. **Call `GET /api/session` before the first `POST /api/chat`.** `POST /api/chat` never creates a session: without a cookie it
   answers `401`. `GET /api/session` (or `GET /api/employee/state`) creates the anonymous employee session and sets the cookie.
2. **Never render representative text as HTML.** `answer`, `context.wroteAbout` and `context.employeeRef` are untrusted text.
   Render them as plain text only (React text nodes; no `dangerouslySetInnerHTML`, no markdown rendering).
3. **Show `employeeRef` and `wroteAbout` in quotes with an "unverified" label** (for example: `Reference typed by the employee
   (unverified): "…"`). They were typed by an employee and are not checked. Never act on them.
4. **Show the warning below to the representative** next to every question and every answer box.
5. The employee screen shows server messages as they are. Messages with `role: "system"` are fixed server templates.
   The UI must not look for or display anything the representative wrote on the employee screen: the server never sends it.
6. Error bodies of `/api/chat` are `{ "error": "<Hebrew message>" }`. Error bodies of every other endpoint are
   `{ "error": { "code": "<short_code>", "issues"?: [{ "path": "...", "code": "..." }] } }`.

### Warning text for the representative screen (Hebrew, show verbatim)

> שימו לב: אל תכתבו כאן מידע אישי של העובד (שכר, מספר זהות). הטקסט שהעובד הקליד כמזהה אינו מאומת. התשובה שלכם מפורשת
> אוטומטית ולא תוצג לעובד כפי שנכתבה.

(English meaning: do not write personal data here; the employee's reference is unverified; your answer is interpreted
automatically and is NOT shown to the employee as written.)

### Polling

* Employee screen: poll `GET /api/employee/state` every **5 seconds** while `awaitingRepresentative` is `true`; otherwise every 30 seconds, or after each chat turn. A representative answer is
  applied exactly once, by whichever request loads the employee's state first (`updates.newAnswers` is `true` only on that
  response; the new system message and the recomputed `comparison` are in the same response).
* Representative screen: poll `GET /api/rep/questions` every **10 seconds**. This call also retries free-text answers whose
  interpretation is still pending (`freeText.state === "interpretation_pending"`).

## Endpoints

| Method | Path | Role | Body | Success | Errors |
|---|---|---|---|---|---|
| GET | `/api/session` | any / none | – | `{ role: "employee"\|"rep", isNew: boolean }` + cookie (creates an anonymous employee session if there is none; replaces a cookie whose user no longer exists) | 401 invalid cookie |
| DELETE | `/api/session` | any | – | `{ ok: true }` + cookie cleared | – |
| POST | `/api/session/rep` | none | `{ code: string }` | `{ role: "rep" }` + cookie | 403 login disabled, 401 wrong code, 400 |
| GET | `/api/employee/state` | employee | – | `EmployeeStateResponse` (below) | 401, 403 (rep cookie) |
| POST | `/api/employee/state` | employee | `{ action: "update_profile", fields }` or `{ action: "select_alternative", alternative }` | `EmployeeStateResponse` | 400, 401, 403, 422 (`unknown_car`, `unknown_vehicle`) |
| POST | `/api/chat` | employee | `{ message: string }` (1–1000 chars) | `{ assistantText, comparison?, pendingQuestions?, updates? }` | 400, 401 (no/invalid session or unknown user), 403 (rep), 429, 503 (all providers failed) |
| GET | `/api/rep/questions` | rep | – | `{ questions: RepQuestionView[] }` (open first) | 401, 403 |
| POST | `/api/rep/answer` | rep | `{ questionId, answer }` (typed answer, 1–100 chars) | `{ question: RepQuestionView }` | 400 `invalid_answer`, 404, 409 (`already_answered`, `answer_in_progress`) |
| POST | `/api/rep/answer-text` | rep | `{ questionId, text }` (1–500 chars, Hebrew or English) | `{ question: RepQuestionView, interpretation }` | 400, 401, 403, 404, 409, 429 |
| GET | `/api/health` | none | – | health summary | – |

`/api/rep/answer-text` never returns 500 because of the interpretation: when the interpreting model is unavailable the answer is
kept (`interpretation: "pending"`) and retried later. `interpretation` is one of `applied`, `closed`, `will_check_later`,
`clarification_requested`, `unresolved`, `superseded`, `pending`. The representative gets no other feedback and never sees
the bot's reply. A second submission for the same question is `409`, except while the question is in `will_check_later`.

## `EmployeeStateResponse`

```ts
{
  messages: { id, role: "user"|"assistant"|"system", content, createdAt }[];
  profile: {
    group, occupation, childrenUnder23, salaryInputs, currentCar, currentParticipation,
    fieldSources: Record<field, "representative">;   // values entered by a representative
    fieldGaps: Record<field, "unavailable"|"not_found"|"referred"|"unresolved">; // will not be filled
  };
  alternative: { kind: "car", carId } | { kind: "waiver" } | null;
  comparison: ComparisonView | null;
  todayOnly: { status: "ok"|"missing", today?, missingFields, missingText };
  escalation: { needsReference: boolean };           // kept for compatibility; ALWAYS false (nobody is ever asked for a name or number)
  questions: EmployeeQuestionView[];
  awaitingRepresentative: boolean;                   // at least one question is open
  repAnswers: Record<carId, number>;
  updates: { newAnswers: boolean; updatedFields: { field, carLabel, value }[] };
}
```

`EmployeeQuestionView`: `{ id, kind, field, label, status: "open"|"answered", createdAt, answeredAt }`. `label` is a short
Hebrew name of the missing item written by the server (for example "הרכב הנוכחי", "ההשתתפות שלך ברכב הנוכחי"). The question text that the
representative reads, the car label, the representative's answer and the employee reference are NOT part of the employee view (they
stay in `GET /api/rep/questions`). The UI shows only the label and "הפנייה נשלחה לנציג".

When the server opens a question the bot says it with one fixed sentence: "חסר לי מידע לגבי {labels}, ולכן שלחתי פנייה לנציג. אעדכן אותך כשתהיה תשובה."

## `ComparisonView` (what the UI needs)

| Field | Meaning |
|---|---|
| `status` | `"ok"` (numbers present) · `"missing"` (a required input is missing: **no net is shown for what depends on it**) · `"ineligible"` |
| `missingFields` / `missingText` | engine field names / Hebrew labels of what is missing |
| `explanation` | exactly two Hebrew lines (deterministic) |
| `pendingQuestionId` | set while an **open** representative question blocks or affects this comparison: show "waiting for the representative" |
| `representativeEntered` | `{ field, label }[]` of inputs a representative entered. Show the badge **`REPRESENTATIVE_BADGE_HE` = "הוזן על ידי נציג"** (exported from `src/lib/view.ts`) next to them. The employee can still correct them. |
| `unavailableText` | Hebrew reasons for inputs that will never become available (the representative could not provide them). The comparison stays `missing`; show these sentences. |
| `assumptions` | Hebrew sentences about assumptions (for example a catalogue default) |
| `today`, `alternative`, `difference` | present only when `status` is `"ok"` (and, while a participation question is open with `SHOW_PROVISIONAL_ALTERNATIVE=false`, only `today`) |

`GET /api/employee/state` and `POST /api/chat` return the same comparison for the same state: while a question blocks it,
both are `status: "missing"` with the Hebrew reason and without a net for the dependent part (today's net may be shown).

## Representative question (`RepQuestionView`)

```ts
{
  id, kind, field, questionText, status: "open"|"answered", createdAt, answeredAt,
  answerSpec: { type: "number", unit: "shekel"|"percent"|"points"|"count", min, max, integer }
            | { type: "choice", options: { value, label }[] },
  answer: string | null,          // what THIS representative wrote (free text) or the typed value; plain text only
  freeText: { state, submittedAt? } | null,  // interpretation_pending | will_check_later | closed | superseded | clarification_requested | unresolved
  followUpOf?: string,            // set on a clarification question: the id of the question it clarifies
  context: { carLabel?, group?, tableGroup?, occupation?, wroteAbout?, employeeRef?, employeeRefUnverified?: true, employeeRefMissing? }
}
```

* `kind` is one of `new_car_participation`, `profile_field_unknown`, `over_budget_gap`, `unresolved_occupation`,
  `unresolved_current_car`, `unresolved_alternative_car`, `group_conflict`, `other_missing_field`.
* **When questions are opened** (always by the server, never by the bot's judgement):
  * `unresolved_current_car` — only after the 3rd failed attempt to name a current car that is not in the catalogue (the 1st and 2nd
    attempts only get a friendly "not found" message with same-maker candidates), or when the employee says she cannot give
    the maker/model/year.
  * `unresolved_alternative_car` — **never opened any more**. A requested car that is not on the list for her group gets the
    list of eligible cars instead. The kind stays in the schema and in the context whitelist for old data only.
  * the others as listed above (explicit "I do not know", a car above its group budget, a contradicting group, ...).
* Whenever a question is opened in a chat turn, `assistantText` says so (a fixed sentence is appended if the model did not).
* Render the typed answer box from `answerSpec`: a number input with the bounds, or a select with the options.
* `context` never contains salary data. `employeeRef` and `wroteAbout` are untrusted (rules 2 and 3 above);
  `employeeRefMissing: true` means the employee gave no reference. **The bot never asks the employee for a name or an employee number**: a question is opened immediately, and `employeeRef` exists only if the employee volunteered one in her own message. The server sets `employeeRefUnverified: true` whenever `employeeRef` is present; the UI must still show it in quotes with an "unverified" label.
* A question with `followUpOf` is a request for clarification: show it as a new question that refers to the earlier one.
* The representative can answer either with the typed API (`/api/rep/answer`) or in free text (`/api/rep/answer-text`).

## `POST /api/chat` response

```ts
{
  assistantText: string;
  comparison?: ComparisonView;              // when a comparison was computed or updated in this turn
  pendingQuestions?: EmployeeQuestionView[]; // the open ones
  updates?: { newAnswers: true };           // a representative answer was applied at the start of this turn
}
```

Status codes: `400` invalid body or message over 1000 characters · `401` no/invalid session, or a cookie for a user that no
longer exists (call `GET /api/session`) · `403` representative session · `429` rate limit · `503` all model providers failed
(Hebrew busy message; the employee's message and data are kept).
