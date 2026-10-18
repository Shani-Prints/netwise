import { handleGetRepQuestions } from '@/lib/handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = (req: Request) => handleGetRepQuestions(req);
