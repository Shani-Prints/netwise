import { notFound } from 'next/navigation';
import { MockRepTicketView } from '../../../rep/MockRepTicketView';

/** Dev-only: one mock ticket. The real console is /rep/[id]. */
export default async function DevRepTicketPage({ params }: { params: Promise<{ id: string }> }) {
  if (process.env.NODE_ENV === 'production') notFound();
  const { id } = await params;
  return <MockRepTicketView id={id} basePath="/dev/rep" />;
}
