/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'memoriaback.iamhuble.space',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: '*.amazonaws.com',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: '**',
        pathname: '/**',
      },
    ],
    unoptimized: true, // Disable optimization for external images
  },
  async rewrites() {
    const coreApiUrl = process.env.CORE_API_URL || 'http://localhost:3001';
    return {
      beforeFiles: [
        {
          source: '/api/v1/:path*',
          destination: `${coreApiUrl}/api/v1/:path*`
        },
        {
          source: '/public/:path*',
          destination: `${coreApiUrl}/public/:path*`
        }
      ],
      afterFiles: [],
      fallback: []
    };
  }
};

module.exports = nextConfig;
