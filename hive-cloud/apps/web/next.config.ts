import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@hive-cloud/contracts", "@hive-cloud/database", "@hive-cloud/security", "@astryxdesign/core"],
  logging: {
    incomingRequests: {
      ignore: [/^\/api\/auth\/callback\//],
    },
  },
  experimental: {
    optimizePackageImports: ["@phosphor-icons/react", "@astryxdesign/core"],
  },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
      ],
    }];
  },
};

export default nextConfig;
