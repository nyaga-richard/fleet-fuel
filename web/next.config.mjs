/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output → small production Docker image (see Dockerfile).
  output: 'standalone',
  async rewrites() {
    // Dev/preview convenience only: when API_PROXY_TARGET is set, same-origin
    // /api requests are proxied to the backend (the browser never talks to
    // localhost directly). Production deployments are unchanged (env unset).
    const target = process.env.API_PROXY_TARGET;
    if (!target) return [];
    return [{ source: '/api/:path*', destination: `${target.replace(/\/+$/, '')}/api/:path*` }];
  },
};

export default nextConfig;
