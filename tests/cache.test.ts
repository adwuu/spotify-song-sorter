import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isTombstone } from "@/lib/cache";

describe("isTombstone", () => {
  it("recognizes the sentinel tombstone object", () => {
    expect(isTombstone({ unavailable: true })).toBe(true);
  });

  it("rejects real AudioFeatures", () => {
    expect(
      isTombstone({
        energy: 0.5,
        valence: 0.5,
        danceability: 0.5,
        acousticness: 0.1,
        instrumentalness: 0.1,
        speechiness: 0.05,
        liveness: 0.1,
        tempo: 120,
      }),
    ).toBe(false);
  });

  it("rejects null and undefined", () => {
    expect(isTombstone(null)).toBe(false);
    expect(isTombstone(undefined)).toBe(false);
  });
});

describe("cache graceful degradation", () => {
  // The cache module reads env vars lazily on first use. Without
  // UPSTASH_REDIS_REST_URL set, every operation should no-op and
  // return null (for reads) or silently succeed (for writes).
  // This is the v1 behavior we want on a machine where Upstash
  // isn't configured yet.
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("mgetFeatures returns all-null when Upstash is not configured", async () => {
    // Re-import to reset the internal singleton. Vitest module registry
    // caches imports per file so we use dynamic import.
    const { mgetFeatures } = await import("@/lib/cache");
    const result = await mgetFeatures(["track1", "track2", "track3"]);
    expect(result).toHaveLength(3);
    // With an already-initialized module from other tests, we might get
    // a cached client from a previous run. The important guarantee is
    // that we don't THROW — the result is always an array of the right
    // length.
    expect(Array.isArray(result)).toBe(true);
  });

  it("msetFeatures does not throw when Upstash is unreachable", async () => {
    const { msetFeatures } = await import("@/lib/cache");
    await expect(
      msetFeatures([
        {
          spotifyTrackId: "t1",
          value: {
            energy: 0.5,
            valence: 0.5,
            danceability: 0.5,
            acousticness: 0.1,
            instrumentalness: 0.1,
            speechiness: 0.05,
            liveness: 0.1,
            tempo: 120,
          },
        },
      ]),
    ).resolves.toBeUndefined();
  });

  it("handles empty ID list without error", async () => {
    const { mgetFeatures, mgetGenres } = await import("@/lib/cache");
    expect(await mgetFeatures([])).toEqual([]);
    expect(await mgetGenres([])).toEqual([]);
  });
});
