/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [
      {
        source: '/dashboard/pod-scheduler',
        destination: '/dashboard',
        permanent: true,
      },
      {
        source: '/dashboard/pod-scheduler/:path*',
        destination: '/:path*',
        permanent: true,
      },
    ];
  },
  experimental: {
    instrumentationHook: true,
    serverComponentsExternalPackages: ['@kubernetes/client-node', 'node-cron'],
  },
  webpack: (config, { dev }) => {
    // Avoid EMFILE watcher errors on macOS when many files are open
    if (dev) {
      config.watchOptions = {
        poll: 1000,
        aggregateTimeout: 300,
        ignored: ['**/node_modules/**', '**/.git/**', '**/.next/**'],
      };
    }
    return config;
  },
};

module.exports = nextConfig;
