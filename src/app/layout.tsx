import type { Metadata, Viewport } from 'next';
import { he } from '../components/car-advisor/content/he';
import './globals.css';

export const metadata: Metadata = {
  title: he.common.appName,
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

/**
 * The dev host page is deliberately plain and left-to-right: the component sets its own direction and
 * language on its own root element, so this page must not need to be RTL.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr">
      <body>{children}</body>
    </html>
  );
}
