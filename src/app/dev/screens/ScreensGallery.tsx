'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ChatWidget } from '../../../components/car-advisor';
import { he } from '../../../components/car-advisor/content/he';
import {
  answerFixture,
  confirmationFixture,
  handoffFixture,
  notificationFixture,
  returnedAnswerFixture,
} from '../../../components/car-advisor/contract/fixtures';
import { Launcher } from '../../../components/car-advisor/Launcher';
import { PreviewBubble } from '../../../components/car-advisor/PreviewBubble';
import { ScopeRoot } from '../../../components/car-advisor/ScopeRoot';
import { EMPTY_CONTACTS, maskContact, UNTOUCHED } from '../../../components/car-advisor/messages/contact';
import type { ChatMessage, HandoffMessage } from '../../../components/car-advisor/useChatController';
import './hostile-host.css';

/** Explicit display so the box keeps its size even inside the hostile host wrapper. */
const WINDOW_BOX = { display: 'block', width: 380, height: 600 } as const;
/** Taller window so the whole hand-off card, including the contact field, is visible. */
const TALL_WINDOW_BOX = { display: 'block', width: 380, height: 1000 } as const;

function Panel({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section style={{ flex: '0 0 auto' }}>
      <h2 style={{ font: '600 14px system-ui', margin: '0 0 8px' }}>{title}</h2>
      <div className={className}>{children}</div>
    </section>
  );
}

function noop() {}

const HANDOFF_QUESTION: ChatMessage = { id: 'gallery-user', kind: 'user', text: handoffFixture.questionText };

/** Placeholder number only, never a real one. Used for the masked display in the confirmation. */
const MASKED_CONTACT = maskContact('phone', '0500000000');

const handoffMessage = (changes: Partial<HandoffMessage> = {}): ChatMessage => ({
  id: 'gallery-handoff',
  kind: 'handoff',
  handoff: handoffFixture,
  channel: handoffFixture.defaultChannel,
  contacts: EMPTY_CONTACTS,
  touched: UNTOUCHED,
  sending: false,
  sent: false,
  maskedContact: null,
  ...changes,
});

const HANDOFF_MESSAGES: ChatMessage[] = [HANDOFF_QUESTION, handoffMessage()];

const HANDOFF_PHONE_ERROR: ChatMessage[] = [
  HANDOFF_QUESTION,
  handoffMessage({ contacts: { phone: '12-345', email: '' }, touched: { phone: true, email: false } }),
];

const HANDOFF_EMAIL_ERROR: ChatMessage[] = [
  HANDOFF_QUESTION,
  handoffMessage({
    channel: 'email',
    contacts: { phone: '', email: 'name@' },
    touched: { phone: false, email: true },
  }),
];

const CONFIRMATION_MESSAGES: ChatMessage[] = [
  HANDOFF_QUESTION,
  handoffMessage({ sent: true, maskedContact: MASKED_CONTACT }),
  {
    id: 'gallery-confirmation',
    kind: 'confirmation',
    confirmation: confirmationFixture,
    maskedContact: MASKED_CONTACT,
  },
];

const RETURNED_MESSAGES: ChatMessage[] = [
  ...CONFIRMATION_MESSAGES,
  { id: 'gallery-returned', kind: 'returned', ticketId: 'ticket-fixture', returned: returnedAnswerFixture },
];

const ANSWER_MESSAGES: ChatMessage[] = [
  { id: 'gallery-user', kind: 'user', text: answerFixture.questionText },
  { id: 'gallery-answer', kind: 'answer', answer: answerFixture },
];

const SECTION_TITLE_STYLE = { font: '700 18px system-ui', margin: '0 0 16px' } as const;
const ROW_STYLE = { display: 'flex', flexWrap: 'wrap', gap: 32, alignItems: 'flex-start' } as const;
const LINK_STYLE = { color: '#02709e', textDecoration: 'underline' } as const;

/** Full-page tools are shown in frames. Frames are fine here because this page is dev-only. */
function PageFrame({
  title,
  src,
  width,
  height,
}: {
  title: string;
  src: string;
  width: number;
  height: number;
}) {
  return (
    <iframe
      title={title}
      src={src}
      style={{ display: 'block', width, height, border: '1px solid #c8d4dc', background: '#fff' }}
    />
  );
}

/** Dev-only gallery: every state of the widget, the launcher, a hostile-host check and the rep console pages. */
export function ScreensGallery() {
  const [launcherOpen, setLauncherOpen] = useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 40, padding: 24 }}>
      <header>
        <h1 style={{ font: '700 24px system-ui', margin: '0 0 8px' }}>
          Car advisor screens (development only)
        </h1>
        <nav style={{ display: 'flex', flexWrap: 'wrap', gap: 20, font: '15px system-ui' }}>
          <Link href="/" style={LINK_STYLE}>
            / live floating chat
          </Link>
          <Link href="/dev/rep" style={LINK_STYLE}>
            /dev/rep ticket list (mock)
          </Link>
          <Link href="/dev/rep/ticket-demo-1" style={LINK_STYLE}>
            /dev/rep/ticket-demo-1 single ticket (mock)
          </Link>
        </nav>
      </header>

      <section>
        <h2 style={SECTION_TITLE_STYLE}>Chat widget states (380x600)</h2>
        <div style={ROW_STYLE}>
          <Panel title="Screen 1: ask">
            <div style={WINDOW_BOX}>
              <ChatWidget onClose={noop} />
            </div>
          </Panel>

          <Panel title="Screen 2: answer">
            <div style={WINDOW_BOX}>
              <ChatWidget onClose={noop} initialMessages={ANSWER_MESSAGES} />
            </div>
          </Panel>

          <Panel title="Screen 3: no answer, hand-off to a rep (contact field)">
            <div style={TALL_WINDOW_BOX}>
              <ChatWidget onClose={noop} initialMessages={HANDOFF_MESSAGES} />
            </div>
          </Panel>

          <Panel title="Screen 3: invalid mobile number (error shown)">
            <div style={TALL_WINDOW_BOX}>
              <ChatWidget onClose={noop} initialMessages={HANDOFF_PHONE_ERROR} />
            </div>
          </Panel>

          <Panel title="Screen 3: email channel, invalid address (error shown)">
            <div style={TALL_WINDOW_BOX}>
              <ChatWidget onClose={noop} initialMessages={HANDOFF_EMAIL_ERROR} />
            </div>
          </Panel>

          <Panel title="Screen 4: confirmation (contact masked)">
            <div style={WINDOW_BOX}>
              <ChatWidget onClose={noop} initialMessages={CONFIRMATION_MESSAGES} />
            </div>
          </Panel>

          <Panel title="Screen 6: notification banner (window open)">
            <div style={WINDOW_BOX}>
              <ChatWidget
                onClose={noop}
                initialMessages={RETURNED_MESSAGES}
                initialBanner={notificationFixture}
              />
            </div>
          </Panel>

          <Panel title="Screen 7: answer returned in the chat">
            <div style={WINDOW_BOX}>
              <ChatWidget onClose={noop} initialMessages={RETURNED_MESSAGES} />
            </div>
          </Panel>
        </div>
      </section>

      <section>
        <h2 style={SECTION_TITLE_STYLE}>Launcher and host isolation</h2>
        <div style={ROW_STYLE}>
          <Panel title="Screen 6, window closed: launcher, unread badge, preview bubble">
            <ScopeRoot
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 16,
                alignItems: 'flex-start',
                width: 300,
              }}
            >
              <Launcher
                expanded={launcherOpen}
                unread={false}
                onClick={() => setLauncherOpen(!launcherOpen)}
              />
              <Launcher expanded={false} unread onClick={noop} />
              <PreviewBubble text={he.notification.title} onOpen={noop} />
            </ScopeRoot>
          </Panel>

          <Panel title="Hostile host (same widget inside aggressive host CSS)" className="hostile-host">
            <div style={WINDOW_BOX}>
              <ChatWidget onClose={noop} />
            </div>
          </Panel>
        </div>
      </section>

      <section>
        <h2 style={SECTION_TITLE_STYLE}>Screen 5: rep console (normal full pages, shown in frames)</h2>
        <div style={ROW_STYLE}>
          <Panel title="/rep list, wide">
            <PageFrame title="Rep console list, wide" src="/dev/rep" width={1040} height={560} />
          </Panel>
          <Panel title="/rep list, mobile (390)">
            <PageFrame title="Rep console list, mobile" src="/dev/rep" width={390} height={844} />
          </Panel>
          <Panel title="/rep/ticket-demo-1 single ticket, wide">
            <PageFrame title="Rep console ticket, wide" src="/dev/rep/ticket-demo-1" width={1040} height={640} />
          </Panel>
          <Panel title="/rep/ticket-demo-4 long content (cards scroll), wide">
            <PageFrame
              title="Rep console long ticket, wide"
              src="/dev/rep/ticket-demo-4"
              width={1040}
              height={640}
            />
          </Panel>
          <Panel title="/rep/ticket-demo-1 single ticket, mobile (390)">
            <PageFrame
              title="Rep console ticket, mobile"
              src="/dev/rep/ticket-demo-1"
              width={390}
              height={1240}
            />
          </Panel>
        </div>
      </section>
    </div>
  );
}
