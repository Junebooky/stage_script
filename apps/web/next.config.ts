import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  transpilePackages: ["@stage/alignment", "@stage/script-engine", "@stage/script-schema", "@stage/shared", "@stage/rehearsal"]
};

export default nextConfig;
