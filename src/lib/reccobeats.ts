/**
 * ReccoBeats API wrapper for audio features.
 *
 * ReccoBeats is a free replacement for Spotify's deprecated audio-features
 * endpoint. Docs: https://reccobeats.com/docs
 *
 * Rate limit strategy:
 *   - Low concurrency (2) to avoid slamming the API
 *   - Read and respect the Retry-After header on 429
 *   - Stop the entire batch immediately on first 429 (don't keep sending)
 *   - Return partial results so the in-memory cache preserves progress
 *   - Next hydrate cycle picks up where we left off
 */

import pLimit from "p-limit";
import type { AudioFeatures } from "./cache";

const BASE_URL = "https://api.reccobeats.com/v1";
const BATCH_RESOLVE_SIZE = 40;
const CONCURRENCY = 2;

/**
 * When we hit a 429, record the timestamp + Retry-After so we can
 * skip requests until the cooldown expires. Shared across all calls
 * within the same process.
 */
let rateLimitedUntil = 0;

function isRateLimited(): boolean {
  return Date.now() < rateLimitedUntil;
}

function recordRateLimit(retryAfterSeconds: number) {
  const waitMs = Math.max(retryAfterSeconds, 5) * 1000;
  rateLimitedUntil = Date.now() + waitMs;
  console.warn(
    `[reccobeats] rate limited — pausing for ${retryAfterSeconds}s (until ${new Date(rateLimitedUntil).toLocaleTimeString()})`,
  );
}

class RateLimitError extends Error {
  constructor(public retryAfter: number) {
    super("Rate limited");
  }
}

async function rbFetch<T>(path: string): Promise<T> {
  // Bail immediately if we're in a cooldown period.
  if (isRateLimited()) {
    throw new RateLimitError(
      Math.ceil((rateLimitedUntil - Date.now()) / 1000),
    );
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Accept: "application/json" },
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("retry-after") ?? "30", 10);
    recordRateLimit(retryAfter);
    throw new RateLimitError(retryAfter);
  }

  if (res.status === 404) {
    return null as T; // Caller handles null as "not found"
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ReccoBeats ${res.status}: ${body.slice(0, 200)}`);
  }

  return (await res.json()) as T;
}

// ───────────────────── batch resolve ─────────────────────

type ResolveResponse = {
  content?: Array<ResolvedTrack>;
  items?: Array<ResolvedTrack>;
};

type ResolvedTrack = {
  id: string;
  href?: string;
  trackTitle?: string;
};

/**
 * Resolve Spotify track IDs to ReccoBeats IDs. Stops on first 429.
 * Returns whatever it managed to resolve before the rate limit hit.
 */
export async function resolveSpotifyIds(
  spotifyTrackIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (spotifyTrackIds.length === 0) return out;

  const unique = Array.from(new Set(spotifyTrackIds));
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += BATCH_RESOLVE_SIZE) {
    chunks.push(unique.slice(i, i + BATCH_RESOLVE_SIZE));
  }

  for (const chunk of chunks) {
    if (isRateLimited()) break; // Stop, don't keep hammering

    try {
      const data = await rbFetch<ResolveResponse>(
        `/track?ids=${chunk.join(",")}`,
      );
      if (data) {
        const items = data.content ?? data.items ?? [];
        for (const item of items) {
          const sp = item.href
            ? item.href.split("/track/").pop()
            : undefined;
          if (sp && item.id) out.set(sp, item.id);
        }
      }
    } catch (err) {
      if (err instanceof RateLimitError) break; // Stop the batch
      console.warn(
        "[reccobeats] resolve chunk failed:",
        (err as Error).message,
      );
    }
  }

  return out;
}

// ───────────────────── audio features ─────────────────────

type AudioFeaturesResponse = {
  acousticness?: number;
  danceability?: number;
  energy?: number;
  instrumentalness?: number;
  liveness?: number;
  loudness?: number;
  speechiness?: number;
  tempo?: number;
  valence?: number;
};

export type FeatureFetchResult =
  | { ok: true; features: AudioFeatures }
  | { ok: false; reason: "not_found" | "error" | "rate_limited" };

function normalizeFeatures(r: AudioFeaturesResponse): AudioFeatures {
  const n = (v: number | undefined): number =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;

  return {
    acousticness: n(r.acousticness),
    danceability: n(r.danceability),
    energy: n(r.energy),
    instrumentalness: n(r.instrumentalness),
    liveness: n(r.liveness),
    speechiness: n(r.speechiness),
    tempo: n(r.tempo),
    valence: n(r.valence),
  };
}

/**
 * Fetch audio features for a single ReccoBeats track ID.
 * Returns immediately if rate-limited.
 */
async function fetchFeaturesForRbId(
  rbId: string,
): Promise<FeatureFetchResult> {
  try {
    const data = await rbFetch<AudioFeaturesResponse | null>(
      `/track/${rbId}/audio-features`,
    );
    if (!data) return { ok: false, reason: "not_found" };
    return { ok: true, features: normalizeFeatures(data) };
  } catch (err) {
    if (err instanceof RateLimitError) {
      return { ok: false, reason: "rate_limited" };
    }
    console.warn("[reccobeats] features fetch failed:", (err as Error).message);
    return { ok: false, reason: "error" };
  }
}

/**
 * Hydrate features for a list of Spotify track IDs (cache misses).
 *
 * Stops gracefully on rate limit — returns partial results for whatever
 * succeeded. The in-memory cache preserves these, so the next hydrate
 * cycle picks up where we left off.
 */
export async function hydrateFeatures(
  spotifyTrackIds: string[],
): Promise<Map<string, FeatureFetchResult>> {
  const out = new Map<string, FeatureFetchResult>();
  if (spotifyTrackIds.length === 0) return out;

  // Step 1: resolve Spotify → ReccoBeats IDs (stops on 429).
  const idMap = await resolveSpotifyIds(spotifyTrackIds);

  // Unresolved IDs: tombstone only if we weren't rate-limited.
  // If rate-limited, leave them as un-cached so we try again next cycle.
  if (!isRateLimited()) {
    for (const sp of spotifyTrackIds) {
      if (!idMap.has(sp)) {
        out.set(sp, { ok: false, reason: "not_found" });
      }
    }
  }

  // Step 2: fetch audio features with low concurrency, stopping on 429.
  const limit = pLimit(CONCURRENCY);
  const entries = Array.from(idMap.entries());

  await Promise.all(
    entries.map(([spotifyId, rbId]) =>
      limit(async () => {
        if (isRateLimited()) {
          // Don't even try — we're in cooldown.
          return;
        }
        const result = await fetchFeaturesForRbId(rbId);
        out.set(spotifyId, result);
      }),
    ),
  );

  const succeeded = Array.from(out.values()).filter((r) => r.ok).length;
  const rateLimited = Array.from(out.values()).filter(
    (r) => !r.ok && r.reason === "rate_limited",
  ).length;
  if (succeeded > 0 || rateLimited > 0) {
    console.log(
      `[reccobeats] hydrated ${succeeded} features` +
        (rateLimited > 0 ? `, ${rateLimited} rate-limited (will retry next cycle)` : ""),
    );
  }

  return out;
}

/** Returns ms until the rate limit cooldown expires, or 0 if not limited. */
export function getRateLimitWaitMs(): number {
  return Math.max(0, rateLimitedUntil - Date.now());
}

/** Exposed for tests. */
export function _resetReccoBeatsInternal(): void {
  rateLimitedUntil = 0;
}
