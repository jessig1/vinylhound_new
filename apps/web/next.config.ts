import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  transpilePackages: ["@vinylhound/contracts", "@vinylhound/domain"],
};

export default nextConfig;
