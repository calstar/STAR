import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produce a self-contained server bundle (.next/standalone) so the runtime
  // image can be a slim node base with no npm install. See Dockerfile.
  output: "standalone",
  // Linting runs as its own CI step (`npm run lint`); don't also run it during
  // `next build`.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
