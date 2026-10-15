import type { NextConfig } from "next";

const nextConfig = {
  agentRules: false,
  typescript: {
    tsconfigPath: "tsconfig.web.json"
  }
} satisfies NextConfig;

export default nextConfig;
