import path from "node:path";

import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

// forceReload (4th arg) is required: Next.js's own internal loadEnvConfig
// call runs before next.config.ts is even evaluated, scoped to this
// directory (apps/web, no monorepo-root .env), and caches that result at
// module scope inside @next/env. Without forceReload, this call silently
// returns that stale cache instead of ever reading the root .env.
loadEnvConfig(
  path.resolve(process.cwd(), "../.."),
  process.env.NODE_ENV !== "production",
  console,
  true,
);

const nextConfig: NextConfig = {
  agentRules: false,
  output: "standalone",
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  // Allows the e2e suite to build/serve from .next-e2e without touching the
  // development server's .next directory.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  poweredByHeader: false,
  serverExternalPackages: ["sharp"],
  transpilePackages: [
    "@vinylhound/config",
    "@vinylhound/contracts",
    "@vinylhound/database",
    "@vinylhound/domain",
    "@vinylhound/storage",
  ],
  webpack(config) {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
