/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  async rewrites() {
    const coreApiUrl = process.env.CORE_API_URL || 'http://localhost:3001';
    return [
      {
        source: '/api/:path*',
        destination: `${coreApiUrl}/:path*`
      }
    ];
  }
};

module.exports = nextConfig;
