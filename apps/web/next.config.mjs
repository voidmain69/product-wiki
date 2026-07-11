/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@wiki/contracts"],
  env: {
    NEXT_PUBLIC_API_URL: process.env.API_URL ?? "http://localhost:3001",
  },
};

export default nextConfig;
