import { AiChat } from '@/components/ai-chat/AiChat';

/** Dev page for trying the streaming fallback chat. Needs a session cookie: open the home page once first. */
export default function AiChatDevPage() {
  return (
    <main style={{ padding: 24 }}>
      <AiChat />
    </main>
  );
}
