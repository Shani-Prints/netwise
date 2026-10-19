import { RealFloatingChat } from '../components/car-advisor';

/** Neutral host page with the floating chat connected to the real API (same origin, session cookie). */
export default function HomePage() {
  return (
    <>
      <main style={{ minHeight: '100dvh' }} />
      <RealFloatingChat />
    </>
  );
}
