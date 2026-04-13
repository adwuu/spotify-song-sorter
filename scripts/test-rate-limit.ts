/**
 * Quick diagnostic: check what HTTP status Spotify is actually returning.
 * Run: npx tsx scripts/test-rate-limit.ts
 */

// Load .env.local
import { readFileSync } from "node:fs";
try {
  const envFile = readFileSync(".env.local", "utf-8");
  for (const line of envFile.split("\n")) {
    const match = line.match(/^([A-Z_]+)=(.+)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
} catch {}

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET ?? "";
const REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN ?? "";

async function main() {
  // Step 1: refresh token
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `grant_type=refresh_token&refresh_token=${REFRESH_TOKEN}`,
  });

  console.log("Token refresh:", tokenRes.status);
  if (tokenRes.status !== 200) {
    console.log("Body:", await tokenRes.text());
    return;
  }

  const token = (await tokenRes.json()) as { access_token: string };
  const auth = { Authorization: `Bearer ${token.access_token}` };
  console.log("Token OK.\n");

  // Step 2: test endpoints
  const endpoints = [
    "/v1/me",
    "/v1/me/tracks?limit=1",
    "/v1/me/playlists?limit=1",
  ];

  for (const ep of endpoints) {
    const res = await fetch(`https://api.spotify.com${ep}`, { headers: auth });
    const retryAfter = res.headers.get("retry-after");
    const body = res.status !== 200 ? await res.text() : "(ok)";
    console.log(
      `${ep}: ${res.status}` +
        (retryAfter ? ` Retry-After: ${retryAfter}s` : "") +
        (res.status !== 200 ? `\n  Body: ${body.slice(0, 200)}` : ""),
    );
  }
}

main().catch(console.error);
