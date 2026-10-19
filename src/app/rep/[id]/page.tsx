import type { Metadata } from 'next';
import { he } from '../../../components/car-advisor/content/he';
import { RepTicketView } from '../RepTicketView';

export const metadata: Metadata = { title: he.rep.title };

// TODO: rep-only access is not enforced yet (see RepShell). Needs a server-side role check before real use.
export default async function RepTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RepTicketView id={id} />;
}
