const path = require('path');
const fs = require('fs');

/** @iarna/toml lives in backend/package.json; Next resolves deps from frontend/. Webpack must alias explicitly. */
function resolveIarnaTomlPackageRoot() {
  const candidates = [
    path.join(__dirname, 'node_modules', '@iarna', 'toml'),
    path.join(__dirname, '..', 'backend', 'node_modules', '@iarna', 'toml'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  }
  return candidates[0];
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Import sensor backend .ts sources from app routes (they use .js extensions in ESM imports).
  webpack: (config) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
    };
    config.resolve.alias = {
      ...config.resolve.alias,
      '@iarna/toml': resolveIarnaTomlPackageRoot(),
    };
    return config;
  },
  // Enable PWA for mobile
  // We'll add PWA config later if needed
  // Allow external access
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Access-Control-Allow-Origin',
            value: '*',
          },
          {
            key: 'Access-Control-Allow-Methods',
            value: 'GET, POST, PUT, DELETE, OPTIONS',
          },
          {
            key: 'Access-Control-Allow-Headers',
            value: 'Content-Type, Authorization',
          },
        ],
      },
    ];
  },
}

module.exports = nextConfig
