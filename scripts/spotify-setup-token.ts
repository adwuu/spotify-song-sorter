/**
 * One-time local OAuth setup script.
 *
 * Runs the Spotify Authorization Code flow (non-PKCE) against a local
 * loopback redirect URI, then prints the refresh token so you can paste
 * it into Vercel's environment variables.
 *
 * Usage:
 *   SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... \
 *     npx tsx scripts/spotify-setup-token.ts
 *
 * Requirements on the Spotify dashboard:
 *   - Redirect URI must include: http://127.0.0.1:8888/callback
 */

import http from "node:http";
import { URL } from "node:url";

const PORT = 8888;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

const SCOPES = [
  "user-library-read",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-public",
  "playlist-modify-private",
];

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env var: ${name}`);
    console.error(
      "Usage: SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... npx tsx scripts/spotify-setup-token.ts",
    );
    process.exit(1);
  }
  return v;
}

const CLIENT_ID = requireEnv("SPOTIFY_CLIENT_ID");
const CLIENT_SECRET = requireEnv("SPOTIFY_CLIENT_SECRET");

const state = Math.random().toString(36).slice(2);
const authUrl =
  "https://accounts.spotify.com/authorize?" +
  new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    state,
    scope: SCOPES.join(" "),
    show_dialog: "true",
  }).toString();

console.log("\nOpen this URL in your browser to authorize:\n");
console.log(authUrl);
console.log("\nListening for callback on", REDIRECT_URI, "\n");

const server = http.createServer(async (req, res) => {
  if (!req.url) return;
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname !== "/callback") {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const err = url.searchParams.get("error");

  if (err) {
    res.end(`Spotify returned error: ${err}`);
    console.error("Spotify error:", err);
    server.close();
    process.exit(1);
  }

  if (returnedState !== state) {
    res.end("State mismatch — aborting.");
    console.error("State mismatch");
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.end("No code received");
    server.close();
    process.exit(1);
  }

  // Exchange the code for tokens.
  try {
    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString(
      "base64",
    );
    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      throw new Error(`Token exchange failed: ${tokenRes.status} ${text}`);
    }

    const data = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
      expires_in: number;
    };

    // Also fetch the user ID so we can stash SPOTIFY_USER_ID.
    const meRes = await fetch("https://api.spotify.com/v1/me", {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    const me = (await meRes.json()) as { id: string; display_name: string };

    res.end(
      "Success! You can close this tab and return to your terminal.",
    );

    console.log("\n─────────────────────────────────────────────");
    console.log("✓ Success! Copy these into your .env.local:");
    console.log("─────────────────────────────────────────────\n");
    console.log(`SPOTIFY_CLIENT_ID=${CLIENT_ID}`);
    console.log(`SPOTIFY_CLIENT_SECRET=${CLIENT_SECRET}`);
    console.log(`SPOTIFY_REFRESH_TOKEN=${data.refresh_token}`);
    console.log(`SPOTIFY_USER_ID=${me.id}`);
    console.log(`\n(Logged in as: ${me.display_name ?? me.id})\n`);
    console.log("Scopes granted:", data.scope);
    console.log(
      "\nThen also add BASIC_AUTH_USER and BASIC_AUTH_PASS of your choice",
    );
    console.log(
      "and the Upstash Redis vars (UPSTASH_REDIS_REST_URL / _TOKEN).\n",
    );

    server.close();
    process.exit(0);
  } catch (e) {
    console.error("Error:", (e as Error).message);
    res.end(`Error: ${(e as Error).message}`);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT);
