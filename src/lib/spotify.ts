/**
 * Spotify API wrapper over @spotify/web-api-ts-sdk.
 *
 * Single-user trust model: the refresh token lives in an env var and is
 * used to mint access tokens on demand. The SDK's ProvidedAccessTokenStrategy
 * handles caching and refresh transparently.
 *
 * Safety:
 * - Never requests `user-library-modify` scope (see Safety Guarantee #3).
 * - The ingestion pagination helpers drop `is_local`, null tracks, and
 *   episodes so downstream code only sees real `Track` objects (Issue 5A).
 */

import { SpotifyApi } from "@spotify/web-api-ts-sdk";
import type {
  AccessToken,
  IAuthStrategy,
  Track,
  SimplifiedPlaylist,
  Artist,
  Page,
  PlaylistedTrack,
} from "@spotify/web-api-ts-sdk";
import pLimit from "p-limit";

// Scopes we need. NOTE: `user-library-modify` is deliberately absent —
// even a bug cannot remove songs from Liked.
export const REQUIRED_SCOPES = [
  "user-library-read",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-public",
  "playlist-modify-private",
];

let cachedApi: SpotifyApi | null = null;

/**
 * Exchange a refresh token for a fresh access token via the Spotify
 * Authorization Code (non-PKCE) flow. Requires client secret.
 */
export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<AccessToken> {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `[spotify] refresh token exchange failed: ${res.status} ${text}`,
    );
  }

  const data = (await res.json()) as {
    access_token: string;
    token_type: string;
    expires_in: number;
    scope?: string;
    refresh_token?: string;
  };

  return {
    access_token: data.access_token,
    token_type: data.token_type,
    expires_in: data.expires_in,
    // Spotify may or may not return a new refresh token; if not, keep the
    // original (it stays valid in non-PKCE Authorization Code flow).
    refresh_token: data.refresh_token ?? refreshToken,
    expires: Date.now() + data.expires_in * 1000,
  };
}

/**
 * Custom IAuthStrategy for single-user server-side refresh.
 *
 * Reasoning: the SDK ships ProvidedAccessTokenStrategy, but it's not in
 * the package's `exports` field so it can't be imported directly. We
 * implement our own minimal strategy that refreshes from the stored
 * refresh token on expiry.
 */
class RefreshingAuthStrategy implements IAuthStrategy {
  private token: AccessToken | null = null;
  private inflight: Promise<AccessToken> | null = null;

  constructor(
    private clientId: string,
    private clientSecret: string,
    private refreshToken: string,
  ) {}

  // SDK wires this up at construction — we don't need it.
  setConfiguration(): void {
    // no-op
  }

  async getAccessToken(): Promise<AccessToken | null> {
    return this.token;
  }

  async getOrCreateAccessToken(): Promise<AccessToken> {
    if (this.token && this.token.expires && this.token.expires > Date.now() + 30_000) {
      return this.token;
    }
    // Dedupe concurrent refresh calls.
    if (this.inflight) return this.inflight;

    this.inflight = (async () => {
      const refreshed = await refreshAccessToken(
        this.clientId,
        this.clientSecret,
        this.refreshToken,
      );
      // Spotify may or may not return a new refresh token; keep the
      // stored one if it didn't (Authorization Code non-PKCE flow).
      if (refreshed.refresh_token) {
        this.refreshToken = refreshed.refresh_token;
      }
      this.token = refreshed;
      return refreshed;
    })();

    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  removeAccessToken(): void {
    this.token = null;
  }
}

/**
 * Get (or lazily construct) the SpotifyApi singleton with a custom auth
 * strategy that transparently refreshes when the access token expires.
 */
export async function getSpotify(): Promise<SpotifyApi> {
  if (cachedApi) return cachedApi;

  const clientId = requireEnv("SPOTIFY_CLIENT_ID");
  const clientSecret = requireEnv("SPOTIFY_CLIENT_SECRET");
  const refreshToken = requireEnv("SPOTIFY_REFRESH_TOKEN");

  const strategy = new RefreshingAuthStrategy(
    clientId,
    clientSecret,
    refreshToken,
  );
  // Warm up: mint the first access token eagerly so failures surface now.
  await strategy.getOrCreateAccessToken();

  cachedApi = new SpotifyApi(strategy);
  return cachedApi;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`[spotify] missing required env var: ${name}`);
  return v;
}

// ───────────────────────── ingestion filter ─────────────────────────

/**
 * Type guard: is this a real (non-local, non-episode) Track?
 * Used to filter out podcasts and local files that Spotify returns
 * inside playlists and liked songs.
 */
export function isRealTrack(x: unknown): x is Track {
  if (!x || typeof x !== "object") return false;
  const t = x as Partial<Track>;
  // Episodes have type === "episode"; real tracks have type === "track".
  // Local files have is_local === true.
  return t.type === "track" && t.is_local === false && typeof t.id === "string";
}

// ───────────────────────── paginated fetchers ─────────────────────────

/**
 * Fetch ALL of the current user's Liked Songs, filtering out non-music
 * items at the lowest layer so downstream code only sees real tracks.
 */
export async function fetchAllLikedSongs(api: SpotifyApi): Promise<Track[]> {
  const out: Track[] = [];
  const limit = 50;
  let offset = 0;

  while (true) {
    const page = await api.currentUser.tracks.savedTracks(limit, offset);
    for (const item of page.items) {
      if (!item || item.track == null) continue;
      if (!isRealTrack(item.track)) continue;
      out.push(item.track);
    }
    if (page.next == null || page.items.length < limit) break;
    offset += limit;
  }

  return out;
}

/**
 * Fetch all owned playlists (filtered to owner.id === userId).
 */
export async function fetchOwnedPlaylists(
  api: SpotifyApi,
  userId: string,
): Promise<SimplifiedPlaylist[]> {
  const out: SimplifiedPlaylist[] = [];
  const limit = 50;
  let offset = 0;

  while (true) {
    const page = await api.currentUser.playlists.playlists(limit, offset);
    for (const p of page.items) {
      if (p?.owner?.id === userId) out.push(p);
    }
    if (page.next == null || page.items.length < limit) break;
    offset += limit;
  }

  return out;
}

/**
 * Fetch all real tracks in a single playlist, filtering out non-music.
 *
 * IMPORTANT: we bypass `@spotify/web-api-ts-sdk`'s `playlists.getPlaylistItems`
 * wrapper because it still calls the DEPRECATED `/playlists/{id}/tracks`
 * endpoint, which returns 403 "Bad OAuth request" for apps created after
 * November 2024. The replacement is `/playlists/{id}/items` (same params,
 * different URL). We call it directly via `api.makeRequest`, which still
 * handles auth and token refresh. Confirmed via Spotify's OpenAPI schema.
 *
 * We also pass `additional_types=episode` even though we don't want
 * episodes — without it, playlists containing podcasts return 403. The
 * ingestion filter downstream drops episodes.
 */
export async function fetchPlaylistTracks(
  api: SpotifyApi,
  playlistId: string,
): Promise<Track[]> {
  const out: Track[] = [];
  const limit = 50;
  let offset = 0;

  while (true) {
    const page = await api.makeRequest<Page<PlaylistedTrack>>(
      "GET",
      `playlists/${playlistId}/items?limit=${limit}&offset=${offset}&additional_types=episode`,
    );

    for (const entry of page.items) {
      if (!entry || entry.is_local) continue;
      // The NEW /items endpoint returns the track under `item`, not `track`.
      // The SDK's PlaylistedTrack type assumes `track` (from the old /tracks
      // endpoint). We handle both shapes defensively.
      const track =
        (entry as unknown as { item?: unknown }).item ?? entry.track;
      if (track == null) continue;
      if (!isRealTrack(track)) continue;
      out.push(track);
    }
    if (page.next == null || page.items.length < limit) break;
    offset += limit;
  }

  return out;
}

/**
 * Fetch tracks for many playlists in parallel (concurrency limit 5).
 * Returns a Map<playlistId, Track[]>.
 *
 * Partial-failure semantics: if one playlist's tracks can't be fetched
 * (e.g. Spotify returns 403 for some edge-case playlist state), log the
 * failure with the playlist ID and skip it — the rest still load. This
 * mirrors the per-playlist try/catch pattern used in applyAction.
 */
export async function fetchAllPlaylistTracks(
  api: SpotifyApi,
  playlistIds: string[],
): Promise<Map<string, Track[]>> {
  const limit = pLimit(5);
  const result = new Map<string, Track[]>();

  await Promise.all(
    playlistIds.map((id) =>
      limit(async () => {
        try {
          const tracks = await fetchPlaylistTracks(api, id);
          result.set(id, tracks);
        } catch (err) {
          const msg = (err as Error).message ?? String(err);
          console.warn(
            `[spotify] fetchPlaylistTracks failed for playlist ${id}: ${msg.slice(0, 300)}`,
          );
          // Set an empty list so the playlist is still present but treated
          // as "too small to fingerprint" by the classifier.
          result.set(id, []);
        }
      }),
    ),
  );

  return result;
}

/**
 * Fetch artist records (for genres) one at a time with bounded
 * parallelism and retry on 429 rate-limit errors.
 *
 * IMPORTANT: the batch `GET /artists?ids=...` endpoint is DEPRECATED
 * and returns 403 for new apps (confirmed via Spotify's OpenAPI schema).
 * There is no batch replacement — we call `GET /artists/{id}` individually.
 *
 * Rate limiting: Spotify's per-app rate limit on new development-mode
 * apps is quite low, so we use concurrency 2 with exponential backoff on
 * 429 (detected via the error message "rate limits"). For a typical
 * ~500-artist library this takes 30–90s on a cold first run; subsequent
 * runs hit the in-memory + Upstash caches instantly.
 *
 * Returns a map from artistId → genres[].
 */
export async function fetchArtistGenres(
  api: SpotifyApi,
  artistIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (artistIds.length === 0) return result;

  const unique = Array.from(new Set(artistIds));
  const limit = pLimit(2);

  await Promise.all(
    unique.map((id) =>
      limit(async () => {
        try {
          const artist = await api.makeRequest<Artist>("GET", `artists/${id}`);
          if (artist && artist.id) {
            result.set(artist.id, artist.genres ?? []);
          }
        } catch (err) {
          const msg = (err as Error).message ?? String(err);
          if (msg.toLowerCase().includes("rate limit")) {
            // Don't retry — record empty genres and move on. The
            // in-memory cache preserves any prior successes, so the
            // next sync attempt (after the rate limit cools) will
            // pick up more. No need to log every single failure.
            result.set(id, []);
          } else {
            console.warn(
              `[spotify] fetch artist ${id} failed: ${msg.slice(0, 200)}`,
            );
            result.set(id, []);
          }
        }
      }),
    ),
  );

  return result;
}

/**
 * Write proposed track URIs to a playlist, splitting >100 URIs across
 * multiple calls. Returns the count added.
 *
 * IMPORTANT: like GET /playlists/{id}/tracks, POST /playlists/{id}/tracks
 * is deprecated and returns 403 for new apps. We use the replacement
 * `/playlists/{id}/items` directly via api.makeRequest.
 */
export async function addTracksToPlaylist(
  api: SpotifyApi,
  playlistId: string,
  trackUris: string[],
): Promise<number> {
  if (trackUris.length === 0) return 0;
  const BATCH = 100;
  let added = 0;

  for (let i = 0; i < trackUris.length; i += BATCH) {
    const slice = trackUris.slice(i, i + BATCH);
    await api.makeRequest<{ snapshot_id: string }>(
      "POST",
      `playlists/${playlistId}/items`,
      { uris: slice },
    );
    added += slice.length;
  }

  return added;
}
