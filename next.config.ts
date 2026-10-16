import type { NextConfig } from "next";

const nextConfig = {
  distDir: process.env.DRONE_NEXT_DIST_DIR ?? '.next',
  agentRules: false,
  typescript: {
    tsconfigPath: "tsconfig.web.json"
  }
} satisfies NextConfig;

export default nextConfig;
