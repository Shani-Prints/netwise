import type { Metadata } from 'next';
import { he } from '../../components/car-advisor/content/he';
import { RepConsole } from './RepConsole';

export const metadata: Metadata = { title: he.repApp.consoleTitle };

/** Real rep console. Access is enforced by the server (rep session cookie); this page only signs in and calls the API. */
export default function RepPage() {
  return <RepConsole />;
}
