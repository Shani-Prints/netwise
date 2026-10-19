import type { Metadata } from 'next';
import { he } from '../../components/car-advisor/content/he';
import { RepList } from './RepList';

export const metadata: Metadata = { title: he.rep.title };

// TODO: rep-only access is not enforced yet (see RepShell). Needs a server-side role check before real use.
export default function RepPage() {
  return <RepList />;
}
