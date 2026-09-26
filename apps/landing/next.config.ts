import type { NextConfig } from 'next';

// Pure static export: Caddy serves `out/` with `file_server` (docs/10-branding.md).
const config: NextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  poweredByHeader: false,
  reactStrictMode: true,
};

export default config;
