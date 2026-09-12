/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output → small production Docker image (see Dockerfile).
  output: 'standalone',
};

export default nextConfig;
