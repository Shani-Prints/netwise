# Car advisor (floating chat)

A self-contained React component that lets an employee ask, in Hebrew, what happens to their monthly net pay if
they switch to an electric car, switch to another car, or give up the car. When the bot has no reliable answer it
hands the question to a human rep. The rep answers **the bot**, and the bot notifies the employee and returns the
answer in the chat.

Copy this folder to the host and import from `index.ts` only. Nothing in the folder imports from outside it,
except `react` and `react-dom`.

```tsx
import { FloatingChat } from './car-advisor';

<FloatingChat client={myClient} position="bottom-left" />;
```

## Public API (`index.ts`)

| Export                                                      | What it is                                                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `FloatingChat`                                              | Launcher button plus chat window, rendered through a portal into `document.body`.             |
| `ChatWidget`                                                | The chat window content only (fills its container). Use it if the host has its own container. |
| `CarAdvisorClient`                                          | The interface the host implements with the real API and its own auth. See below.              |
| `createMockClient`, `MockClientOptions`                     | Demo client with fixtures. It is the default `client` until the host provides one.            |
| View-model types (`AnswerView`, `HandoffView`, `Cell`, ...) | The data shapes the client returns.                                                           |
| `ChatMessage`                                               | Type of the messages in the chat. Only needed for `initialMessages` (development and tests).  |

### `FloatingChat` props

| Prop             | Type                              | Default             | Notes                                                                                  |
| ---------------- | --------------------------------- | ------------------- | -------------------------------------------------------------------------------------- |
| `client`         | `CarAdvisorClient`                | the mock client     | The host passes its real client here.                                                  |
| `position`       | `'bottom-left' \| 'bottom-right'` | `'bottom-left'`     | Corner of the launcher and the window.                                                 |
| `zIndex`         | `number`                          | `2147483000 - 1000` | The only place a z-index is set. Lower it if the host has layers that must stay above. |
| `defaultOpen`    | `boolean`                         | `false`             | Initial state of the window.                                                           |
| `onOpenChange`   | `(open: boolean) => void`         | none                | Called when the user opens or closes the window.                                       |
| `onUnreadChange` | `(unreadCount: number) => void`   | none                | `1` when a rep's answer arrives while the window is closed, `0` when it is read.       |

Behavior: the launcher is a 56px round button. The window is about 380x600, anchored above the launcher, and
nearly full-screen below 480px viewport width. Closing (X or Escape) only hides the window; it stays mounted, so the
conversation and the ticket polling continue. Focus moves into the window when it opens and returns to the launcher
when it closes (non-modal, no focus trap).

### `ChatWidget` props

| Prop              | Type                                    | Default         | Notes                                                                                  |
| ----------------- | --------------------------------------- | --------------- | -------------------------------------------------------------------------------------- |
| `client`          | `CarAdvisorClient`                      | the mock client |                                                                                        |
| `active`          | `boolean`                               | `true`          | Whether the window is visible. Decides between an in-chat banner and `onNotification`. |
| `onClose`         | `() => void`                            | none            | Shows the close (X) button when given.                                                 |
| `onNotification`  | `(n: NotificationView \| null) => void` | none            | Called when a rep's answer arrives while `active` is `false`.                          |
| `initialMessages` | `ChatMessage[]`                         | none            | Development and tests only: start the conversation in a given state.                   |
| `initialBanner`   | `NotificationView`                      | none            | Development and tests only: start with the banner showing.                             |

## The client interface (`CarAdvisorClient`)

The component knows nothing about auth, sessions or endpoints. The host implements this interface with calls to its
own backend. Every method returns display-ready view models (see `contract/types.ts`): text is final Hebrew, and
amounts are `Cell` values that the UI only formats.

| Method                                      | Used by        | What it must do                                                                                                                                                 |
| ------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ask(question)`                             | chat           | Answer the question. Return `{ kind: 'answer', answer }` with the comparison, or `{ kind: 'handoff', handoff }` when the bot has no reliable answer.            |
| `prepareHandoff(question)`                  | chat           | Return a `HandoffView` for a question the employee wants a rep to handle (the "talk to a rep" link on an answer): what was checked, channels.                   |
| `sendToRep(question, { channel, contact })` | chat           | Create the ticket with the chosen notification channel and the employee's contact for it (see below). Return `{ ticketId, ticketNumber, channel }`.             |
| `getReturnedAnswer(ticketId)`               | chat (polling) | Return the rep's answer as a `ReturnedAnswerView` once the bot has it, or `null` while the ticket is open. The widget calls it every 2 seconds per open ticket. |
| `listRepTickets()`                          | rep console    | Open tickets for reps. Must be rep-only.                                                                                                                        |
| `getRepTicket(id)`                          | rep console    | One ticket with what the bot checked, or `null` if it does not exist. Must be rep-only.                                                                         |
| `replyAsRep({ ticketId, answerText })`      | rep console    | Give the rep's answer **to the bot**. The bot words it for the employee, notifies them and makes `getReturnedAnswer` return it. Rep-only.                       |
| `requestMoreInfo(ticketId)`                 | rep console    | Mark the ticket as waiting for more details. Rep-only.                                                                                                          |

The chat widget calls only the first four methods. The rep console pages (`/rep`, `/rep/[id]`) are separate full
pages in our dev app and use the other four. A host that does not ship the rep console can implement those four to
throw or return empty results.

### Contact details for notifications

On the hand-off card the employee chooses how to be notified and must enter a contact for that channel: a
**mobile number** for mobile push and SMS, or an **email address** for email. The widget validates it before the
send button is enabled (Israeli mobile format with or without +972 or dashes; a basic email check) and passes
`sendToRep` a `NotifyTarget`:

```ts
interface NotifyTarget {
  channel: 'push' | 'email' | 'sms';
  contact: string; // normalized: 05XXXXXXXX for push and sms, the trimmed address for email
}
```

- The contact is personal data. The widget keeps it in component state only (never in `localStorage`,
  `sessionStorage`, cookies or logs), shows it masked after sending (only the last 2 digits of a phone number, or
  the first character and the domain of an email) and then removes the full value from memory.
- **The real client must validate the contact again on the server** and must not log it. The host may later prefill
  it from the employee's profile instead of asking for it.
- The mock client uses only the channel and never stores or logs the contact.

### How the host should implement the client

1. **Identity comes from the server session, never from the client.** The methods take no user id on purpose. Your
   backend resolves the employee from its own authentication (for example SSO) on every request and scopes all
   data to that employee. An employee can only ever see their own tickets and answers.
2. **Rep methods are enforced on the server.** Hiding the pages is not access control. The backend must check the
   rep role on `listRepTickets`, `getRepTicket`, `replyAsRep` and `requestMoreInfo`.
3. **Do the calculation on the server.** Net pay, tax and national insurance come from the payroll system and the
   calculation engine. The client only receives the result as `Cell` values and Hebrew text.
4. **Errors:** reject the promise to signal failure. A failed `getReturnedAnswer` poll is retried on the next tick.
   A failed `ask` or `sendToRep` leaves the controls usable again, but the widget does not show an error message
   yet (planned).
5. **Privacy:** never log question text, salary values or answer text (log who, what and when only). Keep all calls
   inside the organization: the component makes no external requests of its own.
6. **Free text is just data.** Question and answer text pass through the client unchanged, so an AI step can be
   added behind `ask` without UI changes.

Minimal shape of an implementation:

```ts
import type { CarAdvisorClient } from './car-advisor';

export const client: CarAdvisorClient = {
  ask: (question) => post('/car-advisor/ask', { question }),
  prepareHandoff: (question) => post('/car-advisor/handoff', { question }),
  sendToRep: (question, notify) => post('/car-advisor/tickets', { question, ...notify }), // notify = { channel, contact }
  getReturnedAnswer: (ticketId) => get(`/car-advisor/tickets/${ticketId}/answer`), // null while open
  listRepTickets: () => get('/car-advisor/rep/tickets'),
  getRepTicket: (id) => get(`/car-advisor/rep/tickets/${id}`),
  replyAsRep: (input) => post(`/car-advisor/rep/tickets/${input.ticketId}/reply`, input),
  requestMoreInfo: (ticketId) => post(`/car-advisor/rep/tickets/${ticketId}/more-info`, {}),
};
```

`get` and `post` are the host's own helpers (they send the session cookie or token). The endpoint paths are only an
example.

### The mock client

`createMockClient({ repReplyDelayMs })` keeps everything in memory. It simulates a rep answering a ticket after
`repReplyDelayMs` (default 6000; `null` turns the simulation off, so a ticket stays open until the rep console
answers it). It never logs, never stores the rep's answer text (only the ticket status changes), and returns
placeholder values (`₪[__]`, `[#1]`, `[SLA]`). Any hand-off question equal to the demo hand-off text triggers the
hand-off path.

## Screens

| Screen                        | Where it lives                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1 Ask                         | `messages/Greeting.tsx` and the composer in `ChatWidget.tsx`                                            |
| 2 Answer and comparison       | `messages/AnswerCard.tsx`, `ui/ComparisonTable.tsx`                                                     |
| 3 No answer, hand-off         | `messages/HandoffCard.tsx`                                                                              |
| 4 Confirmation                | `messages/ConfirmationCard.tsx`                                                                         |
| 6 Notification                | banner in `ChatWidget.tsx`; badge and bubble in `FloatingChat.tsx`, `Launcher.tsx`, `PreviewBubble.tsx` |
| 7 Answer returned in the chat | `messages/ReturnedAnswerCard.tsx`                                                                       |

Screen 5, the rep console, is not part of this component. It lives in `src/app/rep` of our dev app.

## Style isolation

- All styles are CSS Modules plus two scoped plain files (`styles/tokens.css`, `styles/base.css`).
- Every rule is under `[data-car-advisor]`, which sits on the component's own root element together with
  `dir="rtl"` and `lang="he"`. Nothing targets `html`, `body`, `:root` or an unscoped `*`, and nothing sets `dir` or
  `lang` on the host page. There are no global `@font-face` or `@keyframes`.
- Selectors repeat the attribute (`[data-car-advisor][data-car-advisor]`) so ordinary host rules such as
  `.host button` cannot override the component. A host rule that uses `!important` or an `#id` still can.
- The root uses `all: initial`, so host font, color and line-height are not inherited.
- The host needs no Tailwind, no CSS reset and no particular fonts. The host bundler must support CSS Modules and
  global CSS imports from a component (Next, Vite and webpack do).
- Design tokens (brand colors and the accessible variants `#02709E` and `#C9241A`) are custom properties on the
  root, defined once in `styles/tokens.css`.
- z-index is applied only through the `zIndex` prop. Only `FloatingChat` uses viewport sizing. `ChatWidget` sizes
  itself with flex and container queries.
- The `/dev/screens` page has a "hostile host" panel that wraps the widget in aggressive CSS, to check this.

## Fonts

The root font stack is `Heebo`, then system fonts. This component does **not** declare `@font-face`. If the host
wants Heebo, the host loads it (self-hosted, for example `/fonts/Heebo.woff2`). Our dev app declares it in
`src/app/globals.css` and expects the file at `public/fonts/Heebo.woff2`. Without it, the system font is used.

## Data and privacy

- The conversation lives in memory only: no `localStorage`, `sessionStorage` or cookies.
- Question text, amounts, answers and contact details are never logged by the component.
- No external requests: no CDN, fonts, analytics or remote images. Icons are inline SVG.

## Development

- `/` shows the floating chat on an empty page, using the mock client.
- `/dev/screens` shows every state side by side, the launcher, the hostile-host check and the rep console pages. It
  returns 404 in production builds.
- `/rep` and `/rep/[id]` are the rep console. **Rep-only access is not enforced yet** (UI-only phase).

## Folder layout

```
index.ts              public API
FloatingChat.tsx      portal shell: launcher, window, unread badge, preview bubble
ChatWidget.tsx        chat window content, banner, composer
Launcher.tsx, PreviewBubble.tsx
ScopeRoot.tsx         root element (scope attribute, dir, lang)
useChatController.ts  in-memory chat state, hand-off flow, ticket polling
messages/             message components (greeting, answer, hand-off, confirmation, returned answer)
ui/                   internal primitives (not public API; the rep console imports them)
contract/             view-model types, fixtures, mock client
content/he.ts         all Hebrew copy, English keys
styles/               tokens.css (values), base.css (scoped reset)
```
