import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@stage/alignment", "@stage/script-engine", "@stage/script-schema", "@stage/shared"]
};

export default nextConfig;

