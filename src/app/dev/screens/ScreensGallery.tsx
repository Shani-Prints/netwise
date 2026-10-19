'use client';

import { useState } from 'react';
import { ChatWidget } from '../../../components/car-advisor';
import { he } from '../../../components/car-advisor/content/he';
import { Launcher } from '../../../components/car-advisor/Launcher';
import { PreviewBubble } from '../../../components/car-advisor/PreviewBubble';
import { ScopeRoot } from '../../../components/car-advisor/ScopeRoot';
import './hostile-host.css';

/** Explicit display so the box keeps its size even inside the hostile host wrapper. */
const WINDOW_BOX = { display: 'block', width: 380, height: 600 } as const;

function Panel({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section style={{ flex: '0 0 auto' }}>
      <h2 style={{ font: '600 14px system-ui', margin: '0 0 8px' }}>{title}</h2>
      <div className={className}>{children}</div>
    </section>
  );
}

function noop() {}

/** Dev-only gallery: every state of the widget next to each other, plus the launcher and a hostile-host check. */
export function ScreensGallery() {
  const [launcherOpen, setLauncherOpen] = useState(false);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 32, padding: 24, alignItems: 'flex-start' }}>
      <Panel title="Screen 1: ask (widget, 380x600)">
        <div style={WINDOW_BOX}>
          <ChatWidget onClose={noop} />
        </div>
      </Panel>

      <Panel title="Launcher: closed, unread badge, preview bubble">
        <ScopeRoot style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'flex-start', width: 300 }}>
          <Launcher expanded={launcherOpen} unread={false} onClick={() => setLauncherOpen(!launcherOpen)} />
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
  );
}
