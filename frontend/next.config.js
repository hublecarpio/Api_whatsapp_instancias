/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  async rewrites() {
    const coreApiUrl = process.env.CORE_API_URL || 'http://localhost:3001';
    return {
      beforeFiles: [
        {
          source: '/api/v1/:path*',
          destination: `${coreApiUrl}/api/v1/:path*`
        }
      ],
      afterFiles: [],
      fallback: []
    };
  }
};

module.exports = nextConfig;
