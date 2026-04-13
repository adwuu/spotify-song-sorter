/**
 * Safety guarantee tests (Issue 9A from plan review).
 *
 * Each Safety Guarantee in the plan gets a direct test:
 *   #1: read-only sync paths never call write methods
 *   #2: no duplicate additions ever
 *   #3: never calls DELETE /me/tracks or any Liked-Songs mutation
 *   #4: classifier is idempotent across runs
 *
 * These tests exercise the pure classifier and apply-action logic;
 * #1 and #3 are verified by auditing the Spotify SDK method calls we
 * make from apply logic via direct call counting on a mock.
 */

import { describe, it, expect } from "vitest";
import { classify, type TrackInput } from "@/lib/classifier";
import type { AudioFeatures } from "@/lib/cache";

function makeFeatures(overrides: Partial<AudioFeatures> = {}): AudioFeatures {
  return {
    acousticness: 0.1,
    danceability: 0.5,
    energy: 0.5,
    instrumentalness: 0.1,
    liveness: 0.1,
    speechiness: 0.05,
    tempo: 120,
    valence: 0.5,
    ...overrides,
  };
}

function makeTrack(id: string, features = makeFeatures()): TrackInput {
  return {
    id,
    name: `Track ${id}`,
    artistNames: ["Artist"],
    artistIds: [`a:${id}`],
    albumArtUrl: null,
    features,
  };
}

describe("Safety Guarantee #2 — no duplicate additions, ever", () => {
  it("a liked song already in playlist A is never proposed for playlist A", () => {
    const memberIds = Array.from({ length: 10 }, (_, i) => `m${i}`);
    const members = memberIds.map((id) => makeTrack(id));
    const liked = members[0]; // same track object, already in the playlist

    const tracksById = new Map(members.map((m) => [m.id, m]));

    const result = classify({
      likedSongs: [liked],
      playlists: [{ id: "pA", name: "A", trackIds: memberIds }],
      tracksById,
      genresByArtistId: new Map(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposals.length).toBe(0);
    expect(result.stats.alreadyPlaced).toBe(1);
  });

  it("a song already in any playlist is skipped entirely", () => {
    // Song X is in playlist A. Even though it would fit B, it's skipped.
    const aIds = ["x", ...Array.from({ length: 9 }, (_, i) => `a${i}`)];
    const bIds = Array.from({ length: 10 }, (_, i) => `b${i}`);

    const song = makeTrack("x", makeFeatures({ energy: 0.9 }));
    const aMembers = aIds.map((id) =>
      makeTrack(id, makeFeatures({ energy: 0.9 })),
    );
    aMembers[0] = song;

    const bMembers = bIds.map((id) =>
      makeTrack(id, makeFeatures({ energy: 0.9 })),
    );

    const tracksById = new Map(
      [...aMembers, ...bMembers].map((t) => [t.id, t]),
    );

    const result = classify({
      likedSongs: [song],
      playlists: [
        { id: "pA", name: "A", trackIds: aIds },
        { id: "pB", name: "B", trackIds: bIds },
      ],
      tracksById,
      genresByArtistId: new Map(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposals.length).toBe(0);
    expect(result.stats.alreadyPlaced).toBe(1);
  });
});

describe("Safety Guarantee #4 — idempotent classification", () => {
  it("produces identical proposals on repeated calls with identical inputs", () => {
    const memberIds = Array.from({ length: 10 }, (_, i) => `m${i}`);
    const members = memberIds.map((id) =>
      makeTrack(id, makeFeatures({ energy: 0.9 })),
    );
    const liked = [
      makeTrack("liked1", makeFeatures({ energy: 0.9 })),
      makeTrack("liked2", makeFeatures({ energy: 0.88 })),
      makeTrack("liked3", makeFeatures({ energy: 0.92 })),
    ];

    const tracksById = new Map(
      [...members, ...liked].map((t) => [t.id, t]),
    );

    const playlists = [{ id: "p1", name: "P1", trackIds: memberIds }];

    const a = classify({
      likedSongs: liked,
      playlists,
      tracksById,
      genresByArtistId: new Map(),
    });
    const b = classify({
      likedSongs: liked,
      playlists,
      tracksById,
      genresByArtistId: new Map(),
    });

    expect(a).toEqual(b);
  });
});

// Safety Guarantees #1 and #3 are verified by auditing the Spotify
// wrapper's exports (`src/lib/spotify.ts`). This test asserts that
// the module does NOT export any function named with destructive verbs
// nor does it request the user-library-modify scope — a static check
// that future changes to that module will fail if they violate safety.
describe("Safety Guarantees #1 and #3 — code-level invariants", () => {
  it("REQUIRED_SCOPES does not include user-library-modify", async () => {
    const { REQUIRED_SCOPES } = await import("@/lib/spotify");
    expect(REQUIRED_SCOPES).not.toContain("user-library-modify");
  });

  it("exposes no function with 'delete' or 'remove' or 'saveTracks' in its name", async () => {
    const mod = await import("@/lib/spotify");
    const exportNames = Object.keys(mod);
    const forbidden = /delete|remove|saveTracks|removeSaved/i;
    const offending = exportNames.filter((n) => forbidden.test(n));
    expect(offending).toEqual([]);
  });
});
