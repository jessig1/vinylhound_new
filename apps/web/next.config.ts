import path from "node:path";

import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

loadEnvConfig(path.resolve(process.cwd(), "../.."));

const nextConfig: NextConfig = {
  agentRules: false,
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
