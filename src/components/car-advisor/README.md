# Car advisor (floating chat)

A self-contained React component. Copy this folder to the host and import from `index.ts` only.

```tsx
import { FloatingChat } from './car-advisor';

<FloatingChat client={myClient} position="bottom-left" />;
```

## Public API (`index.ts`)

| Export             | What it is                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `FloatingChat`     | Launcher button plus chat window, rendered through a portal into `document.body`.             |
| `ChatWidget`       | The chat window content only (fills its container). Use it if the host has its own container. |
| `CarAdvisorClient` | TypeScript interface the host implements with the real API and its own auth.                  |
| `createMockClient` | Demo client with fixtures. It is the default `client` until the host provides one.            |
| view-model types   | `AnswerView`, `HandoffView`, `ReturnedAnswerView`, ...                                        |

`FloatingChat` props: `client`, `position` (`"bottom-left"` default, or `"bottom-right"`), `zIndex`
(default `2147483000 - 1000`), `defaultOpen`, `onOpenChange`, `onUnreadChange`.

The component knows nothing about auth, sessions or endpoints. Identity must be resolved by the host's client
(server side), never by this component.

## Style isolation

- All styles are CSS Modules plus two scoped plain files (`styles/tokens.css`, `styles/base.css`).
- Every rule is under `[data-car-advisor]`, which sits on the component's own root element together with
  `dir="rtl"` and `lang="he"`. Nothing targets `html`, `body`, `:root` or `*` outside that scope, and nothing sets
  `dir` or `lang` on the host page.
- Selectors repeat the attribute (`[data-car-advisor][data-car-advisor]`) so ordinary host rules such as
  `.host button` cannot override the component. A host rule that uses `!important` or an `#id` still can.
- The root uses `all: initial`, so host font, color and line-height are not inherited.
- The host needs no Tailwind, no CSS reset and no particular fonts. The host bundler must support CSS Modules and
  global CSS imports from a component (Next, Vite and webpack do).
- Design tokens are custom properties on the root, defined once in `styles/tokens.css`.
- z-index is applied only through the `zIndex` prop. Only `FloatingChat` uses viewport sizing. `ChatWidget` sizes
  itself with flex and container queries.

## Fonts

The root font stack is `Heebo`, then system fonts. This component does **not** declare `@font-face`. If the host
wants Heebo, the host loads it (self-hosted, for example `/fonts/Heebo.woff2`). Our dev app declares it in
`src/app/globals.css`. Without it, the system font is used.

## Data and privacy

- The conversation lives in memory only: no `localStorage`, `sessionStorage` or cookies.
- Question text and amounts are never logged.
- No external requests: no CDN, fonts, analytics or remote images. Icons are inline SVG.

## Folder layout

```
index.ts              public API
FloatingChat.tsx      portal shell: launcher, window, unread badge, preview bubble
ChatWidget.tsx        chat window content
ScopeRoot.tsx         root element (scope attribute, dir, lang)
useChatController.ts  in-memory chat state
messages/             message components
ui/                   internal primitives (not public API)
contract/             view-model types, fixtures, mock client
content/he.ts         all Hebrew copy, English keys
styles/               tokens.css (values), base.css (scoped reset)
```
