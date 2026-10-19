import { notFound } from 'next/navigation';
import { ScreensGallery } from './ScreensGallery';

/** Dev-only gallery. It does not exist in production builds. */
export default function DevScreensPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <ScreensGallery />;
}
