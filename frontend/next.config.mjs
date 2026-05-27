/** @type {import('next').NextConfig} */
const nextConfig = {
  // Next.js 16 blocks cross-origin access to dev assets (HMR, /_next/*) by
  // default. Whitelist the LAN/dev hosts we use so React can hydrate and
  // event handlers attach — without this the UI renders but clicks do nothing.
  allowedDevOrigins: [
    '10.145.152.192',
    'localhost',
    '127.0.0.1',
  ],
};

export default nextConfig;
