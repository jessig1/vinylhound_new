import path from "node:path";

import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

// forceReload (4th arg) is required: Next.js's own internal loadEnvConfig
// call runs before next.config.ts is even evaluated, scoped to this
// directory (apps/web, no monorepo-root .env), and caches that result at
// module scope inside @next/env. Without forceReload, this call silently
// returns that stale cache instead of ever reading the root .env — this
// config's own env block below was previously always empty for AUTH_MODE
// and Clerk's keys as a result.
loadEnvConfig(
  path.resolve(process.cwd(), "../.."),
  process.env.NODE_ENV !== "production",
  console,
  true,
);

const nextConfig: NextConfig = {
  agentRules: false,
  // Allows the e2e suite to build/serve from .next-e2e without touching the
  // development server's .next directory.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  poweredByHeader: false,
  // Next.js's own .env* auto-loading only scans this directory (apps/web),
  // never the monorepo-root .env loadEnvConfig() populates above, and Edge
  // middleware/proxy bundles never execute next.config.ts's module code at
  // request time — so without this, AUTH_MODE/Clerk's keys are undefined
  // inside apps/web/src/proxy.ts, silently falling through to the
  // unauthenticated pass-through branch (ADR-0013). This `env` block
  // statically inlines the values into every bundle Next.js builds,
  // including Edge middleware, which runs server/edge-side only and is
  // never shipped to the browser, so CLERK_SECRET_KEY stays safe here.
  env: {
    AUTH_MODE: process.env.AUTH_MODE,
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  },
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
