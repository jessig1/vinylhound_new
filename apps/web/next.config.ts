import path from "node:path";

import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

loadEnvConfig(path.resolve(process.cwd(), "../.."));

const nextConfig: NextConfig = {
  agentRules: false,
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
