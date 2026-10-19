import type { Metadata } from 'next';
import { he } from '../../../components/car-advisor/content/he';
import { RepTicket } from '../RepTicket';

export const metadata: Metadata = { title: he.repApp.consoleTitle };

/** Real rep console, one question. Access is enforced by the server (rep session cookie). */
export default async function RepTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RepTicket id={id} />;
}
