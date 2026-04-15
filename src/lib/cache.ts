/**
 * Upstash Redis cache layer for immutable ReccoBeats audio features
 * and Spotify artist genres.
 *
 * Safety guarantee: the cache is an optimization, not a correctness
 * primitive. Read errors are treated as misses; write errors are logged
 * but do not interrupt the sync. See Issue 7A in the plan.
 *
 * Key schemas:
 *   features:{spotifyTrackId}  → AudioFeatures | Tombstone
 *   genres:{spotifyArtistId}   → string[]
 */

import { Redis } from "@upstash/redis";

// Env var names per Upstash Marketplace integration.
// If you're running locally without Upstash provisioned, these will be
// undefined and the client will throw on construction — we handle that
// by wrapping reads/writes in try/catch so the whole sync still works.
let redis: Redis | null = null;
let redisChecked = false;

function getRedis(): Redis | null {
  if (redis) return redis;
  if (redisChecked) return null; // Already tried and failed; don't spam logs.
  redisChecked = true;

  // Check env vars before calling fromEnv() so we don't trigger
  // @upstash/redis's verbose warning spam when they're missing.
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    console.warn(
      "[cache] Upstash not configured (UPSTASH_REDIS_REST_URL / _TOKEN missing). Using in-memory only.",
    );
    return null;
  }

  try {
    redis = Redis.fromEnv();
    return redis;
  } catch (err) {
    console.warn(
      "[cache] Upstash init failed, using in-memory only:",
      (err as Error).message,
    );
    return null;
  }
}

/**
 * In-memory fallback cache. Lives at module scope so it survives across
 * server action invocations within the same Next.js dev process. Loses
 * all data on server restart.
 *
 * Purpose: without Upstash configured locally, a cold first hydrate can
 * take minutes, and if any single call fails mid-run the user has to
 * start over. The in-memory layer preserves partial progress so repeated
 * syncs converge.
 */
const memFeatures = new Map<string, FeaturesValue>();
const memGenres = new Map<string, string[]>();
const memTrackTags = new Map<string, string[]>();

export type AudioFeatures = {
  energy: number;
  valence: number;
  danceability: number;
  acousticness: number;
  instrumentalness: number;
  speechiness: number;
  liveness: number;
  tempo: number;
};

type Tombstone = { unavailable: true };
type FeaturesValue = AudioFeatures | Tombstone;

export function isTombstone(
  v: FeaturesValue | null | undefined,
): v is Tombstone {
  return !!v && typeof v === "object" && "unavailable" in v;
}

const FEATURES_PREFIX = "features:";
const GENRES_PREFIX = "genres:";
const TRACK_TAGS_PREFIX = "tags:";

/**
 * Batch read audio features. Returns an array parallel to input IDs.
 * Missing or error entries are `null` in the result array.
 *
 * Read order: in-memory → Upstash → null. In-memory wins so a warm
 * process doesn't pay for Upstash round trips.
 */
export async function mgetFeatures(
  spotifyTrackIds: string[],
): Promise<Array<FeaturesValue | null>> {
  if (spotifyTrackIds.length === 0) return [];

  // Start with in-memory lookups; build a list of remaining misses for Upstash.
  const out: Array<FeaturesValue | null> = spotifyTrackIds.map(
    (id) => memFeatures.get(id) ?? null,
  );
  const missingIdx: number[] = [];
  for (let i = 0; i < spotifyTrackIds.length; i++) {
    if (out[i] == null) missingIdx.push(i);
  }
  if (missingIdx.length === 0) return out;

  const r = getRedis();
  if (!r) return out;

  try {
    const keys = missingIdx.map(
      (i) => `${FEATURES_PREFIX}${spotifyTrackIds[i]}`,
    );
    const results = await r.mget<Array<FeaturesValue | null>>(...keys);
    for (let j = 0; j < missingIdx.length; j++) {
      const v = results[j];
      if (v != null) {
        out[missingIdx[j]] = v;
        // Promote to in-memory so repeated reads are free.
        memFeatures.set(spotifyTrackIds[missingIdx[j]], v);
      }
    }
  } catch (err) {
    console.warn(
      "[cache] mgetFeatures failed, treating Upstash misses as null:",
      (err as Error).message,
    );
  }

  return out;
}

/**
 * Batch write audio features (or tombstones). Fire-and-forget semantics:
 * errors are logged but do not throw. Always writes to in-memory first
 * so partial progress survives even when Upstash is down or unconfigured.
 */
export async function msetFeatures(
  entries: Array<{ spotifyTrackId: string; value: FeaturesValue }>,
): Promise<void> {
  if (entries.length === 0) return;

  // In-memory write always succeeds.
  for (const { spotifyTrackId, value } of entries) {
    memFeatures.set(spotifyTrackId, value);
  }

  const r = getRedis();
  if (!r) return;

  try {
    const obj: Record<string, FeaturesValue> = {};
    for (const { spotifyTrackId, value } of entries) {
      obj[`${FEATURES_PREFIX}${spotifyTrackId}`] = value;
    }
    await r.mset(obj);
  } catch (err) {
    console.warn(
      "[cache] msetFeatures failed, continuing without cache:",
      (err as Error).message,
    );
  }
}

/**
 * Batch read artist genres. Returns array of string[] (possibly empty)
 * parallel to input IDs. Missing entries are `null`.
 */
export async function mgetGenres(
  spotifyArtistIds: string[],
): Promise<Array<string[] | null>> {
  if (spotifyArtistIds.length === 0) return [];

  const out: Array<string[] | null> = spotifyArtistIds.map(
    (id) => memGenres.get(id) ?? null,
  );
  const missingIdx: number[] = [];
  for (let i = 0; i < spotifyArtistIds.length; i++) {
    if (out[i] == null) missingIdx.push(i);
  }
  if (missingIdx.length === 0) return out;

  const r = getRedis();
  if (!r) return out;

  try {
    const keys = missingIdx.map(
      (i) => `${GENRES_PREFIX}${spotifyArtistIds[i]}`,
    );
    const results = await r.mget<Array<string[] | null>>(...keys);
    for (let j = 0; j < missingIdx.length; j++) {
      const v = results[j];
      if (v != null) {
        out[missingIdx[j]] = v;
        memGenres.set(spotifyArtistIds[missingIdx[j]], v);
      }
    }
  } catch (err) {
    console.warn(
      "[cache] mgetGenres failed, treating Upstash misses as null:",
      (err as Error).message,
    );
  }

  return out;
}

/**
 * Batch write artist genres. Errors logged, not thrown. Always writes
 * to in-memory first so partial progress survives Upstash outages.
 */
export async function msetGenres(
  entries: Array<{ spotifyArtistId: string; genres: string[] }>,
): Promise<void> {
  if (entries.length === 0) return;

  for (const { spotifyArtistId, genres } of entries) {
    memGenres.set(spotifyArtistId, genres);
  }

  const r = getRedis();
  if (!r) return;

  try {
    const obj: Record<string, string[]> = {};
    for (const { spotifyArtistId, genres } of entries) {
      obj[`${GENRES_PREFIX}${spotifyArtistId}`] = genres;
    }
    await r.mset(obj);
  } catch (err) {
    console.warn(
      "[cache] msetGenres failed, continuing without cache:",
      (err as Error).message,
    );
  }
}

// ───────────────────── track-level tags (Last.fm) ─────────────────────

/**
 * Batch read track-level genre tags. Returns array parallel to input IDs.
 * Missing entries are `null`. Empty array `[]` is a tombstone (looked up,
 * no usable tags found).
 */
export async function mgetTrackTags(
  spotifyTrackIds: string[],
): Promise<Array<string[] | null>> {
  if (spotifyTrackIds.length === 0) return [];

  const out: Array<string[] | null> = spotifyTrackIds.map(
    (id) => memTrackTags.get(id) ?? null,
  );
  const missingIdx: number[] = [];
  for (let i = 0; i < spotifyTrackIds.length; i++) {
    if (out[i] == null) missingIdx.push(i);
  }
  if (missingIdx.length === 0) return out;

  const r = getRedis();
  if (!r) return out;

  try {
    const keys = missingIdx.map(
      (i) => `${TRACK_TAGS_PREFIX}${spotifyTrackIds[i]}`,
    );
    const results = await r.mget<Array<string[] | null>>(...keys);
    for (let j = 0; j < missingIdx.length; j++) {
      const v = results[j];
      if (v != null) {
        out[missingIdx[j]] = v;
        memTrackTags.set(spotifyTrackIds[missingIdx[j]], v);
      }
    }
  } catch (err) {
    console.warn(
      "[cache] mgetTrackTags failed, treating Upstash misses as null:",
      (err as Error).message,
    );
  }

  return out;
}

/**
 * Batch write track-level genre tags. Empty array `[]` is a valid
 * tombstone (means "no usable tags"). Errors logged, not thrown.
 */
export async function msetTrackTags(
  entries: Array<{ spotifyTrackId: string; tags: string[] }>,
): Promise<void> {
  if (entries.length === 0) return;

  for (const { spotifyTrackId, tags } of entries) {
    memTrackTags.set(spotifyTrackId, tags);
  }

  const r = getRedis();
  if (!r) return;

  try {
    const obj: Record<string, string[]> = {};
    for (const { spotifyTrackId, tags } of entries) {
      obj[`${TRACK_TAGS_PREFIX}${spotifyTrackId}`] = tags;
    }
    await r.mset(obj);
  } catch (err) {
    console.warn(
      "[cache] msetTrackTags failed, continuing without cache:",
      (err as Error).message,
    );
  }
}
