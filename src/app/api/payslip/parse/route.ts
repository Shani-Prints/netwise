import { handlePayslipParse } from '@/lib/payslipParse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const POST = (req: Request) => handlePayslipParse(req);
