# Golden conversations

A golden conversation is a whole chat written as data: the employee's messages, what the (fake) model answers, what a
representative does between turns, and what the **server** must have done after each step. Every bug that was found in a real
conversation becomes one more `.json` file here, so it stays fixed.

* Runner: `runner.test.ts` (all `*.json` in this folder) and `lowBudget.test.ts` (all `*.json` in `low-budget/`, run with a copy
  of the rules in which group ג has a budget of 3000, needed for the over-budget case).
* Engine: `engine.ts`. Format (zod schema, the source of truth): `format.ts`.
* No real model is called. The model is a scripted fake (`tests/agent/fakes.ts`), the repo is the in-memory repo, and the chat,
  state and representative handlers, the matchers, the guard, the escalation rules and the calculation engine are the real ones.
* The JSON files are the source; write them by hand.

## File format

```jsonc
{
  "id": "02-real-no-children-credit-points-typed",     // same as the file name
  "description": "one sentence: what must stay true",
  "tags": ["real-failure"],
  "steps": [ /* employee steps and representative steps, in order */ ]
}
```

### Employee step

```jsonc
{
  "employee": "the message the employee types",
  "model": [                                        // one item per model request of this turn, in order
    { "tool": "save_employee_data", "input": { "base": 18500 } },
    { "say": "the final text of the model. {{todayNet}} {{alternativeNet}} {{difference}} are filled from the last comparison tool result" }
  ],
  "expect": { /* see below */ }
}
```

The model items must all be used (a script that is too long or too short fails). A turn that ends with a tool call and no
`say` is not possible: the last item is always `say`.

### Representative step

```jsonc
{
  "rep": {
    "kind": "profile_field_unknown",       // which OPEN question (kind and/or field; the first match)
    "field": "creditPoints",
    "typed": "2.75",                       // the typed API (a number or an option id) ...
    "text": "אין לה נקודות זיכוי",          // ... or free text, with the answer of the fake interpreter:
    "interpretation": { "result": "values", "values": [{ "field": "creditPoints", "value": "0" }] }
    //   or { "result": "outcome", "outcome": "employee_not_found" | "will_check_later" | "refer_elsewhere" | "value_unavailable" | "approved" | "denied" }
    //   or { "result": "not_understood" }  or { "status": "unavailable" | "invalid" }
  },
  "expect": { "repStatus": 200, "repInterpretation": "applied" }
}
```

After a representative step the employee screen loads its state (that is where an answer is applied), then the expectations
are checked.

### `expect` (all keys optional, checked after the step)

| Key | Meaning |
|---|---|
| `status` | HTTP status of the chat call (default 200) |
| `text.contains / notContains / matches / notMatches` | the assistant text (matches = regular expressions, flag `u`) |
| `profile` | subset match on `profile` of the employee state (`group`, `occupation`, `childrenUnder23`, `salaryInputs`, `currentParticipation`) |
| `currentCarLabelContains`, `currentCar: null` | the current car as the employee sees it |
| `fieldSources`, `fieldGaps` | exact match (`{ "creditPoints": "representative" }`) |
| `openQuestions` | the OPEN representative questions as a set of `{kind, field}` (use `[]` for none) |
| `totalQuestions` | open + answered questions in the conversation |
| `questionLabels`, `awaitingRepresentative` | what the employee-facing state shows for the open questions |
| `comparison` | `status` (`ok`/`missing`/`ineligible`/`none`), `hasNumbers`, `alternativeLabelContains`, `pending`, `representativeEntered`, `missingFieldsInclude` |
| `todayOnly` | `ok` / `missing` |
| `notices` | text checks on the system messages (role "system") |
| `replaced` | `true`/`false`, or `{ "reason": "unknown_number" }`: the server replaced the model text (guard or empty answer) |
| `repStatus`, `repInterpretation` | for a representative step |

### Invariants (not listed in the files)

After every employee step the invariant checker (`src/testing/invariants.ts`) runs, and after every representative step the
subset that applies (b, f, g, h). A violation fails the step with the invariant letter:

a numbers in the assistant text come from tools / SERVER STATE · b no representative text or question text on the employee side ·
c no identification requested · d no technical vehicle data requested · e "I sent a question" only if one is open ·
f no salary value in a representative context · g a stated field is not escalated · h no empty card or heading (the real
React panels are rendered).

## Adding a conversation for a new bug

1. Copy the closest file, give it the next number, and write the employee messages exactly as the person wrote them.
2. Script the model as it behaved in the real run (tool calls and text).
3. Write what must be true afterwards. Run `pnpm test tests/golden`. It must fail before the fix and pass after it.
4. If the case needs different rules (a budget), put it in `low-budget/` or add another runner like `lowBudget.test.ts`.

A conversation that documents a known gap (not a bug that was fixed) carries the tag `known-gap` and says so in its description.
