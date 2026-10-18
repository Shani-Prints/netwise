import { handleGetEmployeeState, handlePostEmployeeState } from '@/lib/handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = (req: Request) => handleGetEmployeeState(req);
export const POST = (req: Request) => handlePostEmployeeState(req);
