import { handlePostRepAnswer } from '@/lib/handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = (req: Request) => handlePostRepAnswer(req);
