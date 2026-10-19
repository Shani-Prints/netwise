import { handleRepAnswerText } from '@/agent/repTextHandlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const POST = (req: Request) => handleRepAnswerText(req);
