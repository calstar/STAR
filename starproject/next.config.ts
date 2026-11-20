import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produce a self-contained server bundle (.next/standalone) so the runtime
  // image can be a slim node base with no npm install. See Dockerfile.
  output: "standalone",
  // Linting runs as its own CI step (`npm run lint`); don't also run it during
  // `next build`.
  eslint: { ignoreDuringBuilds: true },
  // Nothing here is meant to be framed: above all the OAuth consent page, where
  // a framed "Allow" click would hand a token to whoever built the frame.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
