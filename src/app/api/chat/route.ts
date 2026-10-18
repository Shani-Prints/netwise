import { handleChat } from '@/agent/chatHandler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const POST = (req: Request) => handleChat(req);
