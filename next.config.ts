import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin workspace root so Next doesn't get confused by stray lockfiles
  // higher up the filesystem.
  turbopack: {
    root: __dirname,
  },
  // Allow album art thumbnails from Spotify's CDN in the proposal table.
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "i.scdn.co" },
      { protocol: "https", hostname: "mosaic.scdn.co" },
    ],
  },
};

export default nextConfig;
