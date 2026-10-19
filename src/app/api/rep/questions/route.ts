import { handleRepQuestionsWithRetry } from '@/agent/repTextHandlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const GET = (req: Request) => handleRepQuestionsWithRetry(req);
