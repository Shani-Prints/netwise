import { notFound } from 'next/navigation';
import { MockRepList } from '../../rep/MockRepList';

/** Dev-only: the rep console with MOCK data (the gallery frames it). The real console is /rep. */
export default function DevRepPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <MockRepList basePath="/dev/rep" />;
}
