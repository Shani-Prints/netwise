import { handleDeleteSession, handleGetSession } from '@/lib/handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = (req: Request) => handleGetSession(req);
export const DELETE = (req: Request) => handleDeleteSession(req);
