import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  devIndicators: false,
  // The server needs the rules + generated data (+ usage-value CSV for the dev lookup) at runtime.
  outputFileTracingIncludes: {
    '/api/**/*': ['./data/**/*'],
  },
};

export default nextConfig;
