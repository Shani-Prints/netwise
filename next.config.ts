import type { NextConfig } from 'next';

// Runtime data read with fs (src/config/rules.ts, src/data/catalog.ts, src/data/usageValues.ts; paths come from process.cwd()).
// Next cannot trace these reads, so every API function lists the files it may need. The source spreadsheet and the
// reference results are only used by scripts and tests and stay out of the bundle.
const RUNTIME_DATA = [
  './data/strauss-rules.json',
  './data/generated/catalog.json',
  './data/generated/occupations.json',
  './data/generated/sample-employees.json',
  './data/usage-value-2026.csv',
];

const nextConfig: NextConfig = {
  devIndicators: false,
  outputFileTracingIncludes: {
    '/api/**/*': RUNTIME_DATA,
  },
  outputFileTracingExcludes: {
    '/api/**/*': ['./data/challenge-data.xlsx', './data/generated/reference-results.json'],
  },
};

export default nextConfig;
