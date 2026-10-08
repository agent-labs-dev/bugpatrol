import type { NextConfig } from 'next';

// GitHub Pages serves the site under /bugpatrol, so the deploy sets this.
const basePath = process.env.SITE_BASE_PATH ?? '';

const nextConfig: NextConfig = {
  output: 'export',
  basePath,
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  images: { unoptimized: true },
  trailingSlash: true,
};

export default nextConfig;
