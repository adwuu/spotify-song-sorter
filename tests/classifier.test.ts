import { describe, it, expect } from "vitest";
import {
  classify,
  _internal,
  type TrackInput,
  type PlaylistInput,
  type ClassifyInput,
} from "@/lib/classifier";
import type { AudioFeatures } from "@/lib/cache";

// ──────────────── helpers ────────────────

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

function makeTrack(
  id: string,
  opts: Partial<TrackInput> & { features?: AudioFeatures | null } = {},
): TrackInput {
  return {
    id,
    name: `Track ${id}`,
    artistNames: ["Artist"],
    artistIds: [`a:${id}`],
    albumArtUrl: null,
    features: opts.features === undefined ? makeFeatures() : opts.features,
    ...opts,
  };
}

function makeInput(
  likedSongs: TrackInput[],
  playlists: PlaylistInput[],
  extraTracks: TrackInput[] = [],
  genresByArtistId: Map<string, string[]> = new Map(),
): ClassifyInput {
  const tracksById = new Map<string, TrackInput>();
  for (const t of [...likedSongs, ...extraTracks]) tracksById.set(t.id, t);
  return { likedSongs, playlists, tracksById, genresByArtistId };
}

// ──────────────── vector construction + NaN guards ────────────────

describe("buildVector", () => {
  it("defaults missing audio features to 0", () => {
    const t = makeTrack("a", { features: null });
    const v = _internal.buildVector(t, new Map(), [], new Map());
    // audio block is all zeros; no genre block.
    expect(v.length).toBe(8);
    expect(Array.from(v.slice(0, 8))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("handles NaN tempo safely (no NaN propagation)", () => {
    const t = makeTrack("a", { features: makeFeatures({ tempo: NaN }) });
    const v = _internal.buildVector(t, new Map(), [], new Map());
    for (let i = 0; i < v.length; i++) expect(Number.isFinite(v[i])).toBe(true);
    expect(v[7]).toBe(0); // tempo normalized slot is 0
  });

  it("handles Infinity values safely", () => {
    const t = makeTrack("a", { features: makeFeatures({ energy: Infinity }) });
    const v = _internal.buildVector(t, new Map(), [], new Map());
    for (let i = 0; i < v.length; i++) expect(Number.isFinite(v[i])).toBe(true);
  });

  it("normalizes tempo to [0, 1]", () => {
    const slow = _internal.buildVector(
      makeTrack("s", { features: makeFeatures({ tempo: 60 }) }),
      new Map(),
      [],
      new Map(),
    );
    const fast = _internal.buildVector(
      makeTrack("f", { features: makeFeatures({ tempo: 180 }) }),
      new Map(),
      [],
      new Map(),
    );
    expect(slow[7]).toBeCloseTo(0.3);
    expect(fast[7]).toBeCloseTo(0.9);
  });

  it("clamps tempo above 200 BPM to 1.0", () => {
    const v = _internal.buildVector(
      makeTrack("x", { features: makeFeatures({ tempo: 300 }) }),
      new Map(),
      [],
      new Map(),
    );
    expect(v[7]).toBe(1);
  });

  it("produces empty genre block when vocabulary is empty", () => {
    const v = _internal.buildVector(
      makeTrack("a"),
      new Map(),
      [],
      new Map(),
    );
    expect(v.length).toBe(8);
  });

  it("sets genre dimensions for matching artists", () => {
    const t = makeTrack("a", { artistIds: ["art1", "art2"] });
    const genresByArtist = new Map([
      ["art1", ["indie rock", "shoegaze"]],
      ["art2", ["indie rock"]],
    ]);
    const vocab = ["indie rock", "shoegaze"].sort();
    const genreIndex = new Map(vocab.map((g, i) => [g, i]));
    const v = _internal.buildVector(t, genresByArtist, vocab, genreIndex);
    expect(v.length).toBe(10); // 8 audio + 2 genre
    // Both genre dims should be non-zero (weighted).
    expect(v[8]).toBeGreaterThan(0);
    expect(v[9]).toBeGreaterThan(0);
  });
});

// ──────────────── centroids + tightness ────────────────

describe("buildCentroid", () => {
  it("centroid of a single track equals the track vector", () => {
    const t = makeTrack("a");
    const v = _internal.buildVector(t, new Map(), [], new Map());
    const p: PlaylistInput = { id: "p1", name: "P1", trackIds: ["a"] };
    const c = _internal.buildCentroid(p, [v]);
    for (let i = 0; i < v.length; i++) expect(c.vector[i]).toBeCloseTo(v[i]);
  });

  it("tightness of identical member vectors is 1.0", () => {
    const v = _internal.buildVector(makeTrack("a"), new Map(), [], new Map());
    const p: PlaylistInput = {
      id: "p1",
      name: "P1",
      trackIds: ["a", "b", "c"],
    };
    const c = _internal.buildCentroid(p, [v, v, v]);
    expect(c.tightness).toBeCloseTo(1);
  });

  it("precomputed norm matches on-the-fly norm computation", () => {
    const v = _internal.buildVector(
      makeTrack("a", { features: makeFeatures({ energy: 0.9, valence: 0.4 }) }),
      new Map(),
      [],
      new Map(),
    );
    const p: PlaylistInput = { id: "p1", name: "P1", trackIds: ["a"] };
    const c = _internal.buildCentroid(p, [v]);
    expect(c.vectorNorm).toBeCloseTo(_internal.norm(v));
  });
});

// ──────────────── assignment ────────────────

describe("classify", () => {
  it("returns no_eligible_playlists when no playlist is large enough", () => {
    const result = classify(
      makeInput(
        [makeTrack("liked1")],
        [{ id: "p1", name: "Tiny", trackIds: ["t1", "t2", "t3"] }],
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("no_eligible_playlists");
  });

  it("assigns a song above threshold", () => {
    // A playlist of 10 energetic tracks.
    const memberIds = Array.from({ length: 10 }, (_, i) => `m${i}`);
    const members = memberIds.map((id) =>
      makeTrack(id, {
        features: makeFeatures({ energy: 0.9, danceability: 0.9 }),
      }),
    );
    // A matching liked song.
    const liked = makeTrack("liked1", {
      features: makeFeatures({ energy: 0.9, danceability: 0.9 }),
    });

    const result = classify(
      makeInput(
        [liked],
        [{ id: "workout", name: "Workout", trackIds: memberIds }],
        members,
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposals.length).toBe(1);
      expect(result.proposals[0].playlistId).toBe("workout");
      expect(result.proposals[0].similarity).toBeGreaterThan(0.75);
    }
  });

  it("leaves a song alone when below threshold", () => {
    // A playlist of mellow tracks.
    const memberIds = Array.from({ length: 10 }, (_, i) => `m${i}`);
    const members = memberIds.map((id) =>
      makeTrack(id, {
        features: makeFeatures({ energy: 0.1, valence: 0.2, tempo: 60 }),
      }),
    );
    // A polar-opposite liked song.
    const liked = makeTrack("liked1", {
      features: makeFeatures({ energy: 1, valence: 1, tempo: 200 }),
    });

    const result = classify(
      makeInput(
        [liked],
        [{ id: "mellow", name: "Mellow", trackIds: memberIds }],
        members,
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should not be assigned because it's dissimilar.
      expect(result.proposals.length).toBe(0);
    }
  });

  it("SAFETY #2: skips songs already in a custom playlist", () => {
    // Liked song is also a member of the playlist.
    const memberIds = Array.from({ length: 10 }, (_, i) => `m${i}`);
    const members = memberIds.map((id) => makeTrack(id));
    const liked = members[0]; // same as m0, already in the playlist

    const result = classify(
      makeInput(
        [liked],
        [{ id: "p1", name: "P1", trackIds: memberIds }],
        members,
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Even though it would match its own playlist perfectly, it should be skipped.
      expect(result.proposals.length).toBe(0);
      expect(result.stats.alreadyPlaced).toBe(1);
    }
  });

  it("SAFETY #4: is idempotent across runs", () => {
    const memberIds = Array.from({ length: 10 }, (_, i) => `m${i}`);
    const members = memberIds.map((id) =>
      makeTrack(id, { features: makeFeatures({ energy: 0.9 }) }),
    );
    const liked = makeTrack("liked1", {
      features: makeFeatures({ energy: 0.9 }),
    });

    const inputA = makeInput(
      [liked],
      [{ id: "p1", name: "P1", trackIds: memberIds }],
      members,
    );
    const inputB = makeInput(
      [liked],
      [{ id: "p1", name: "P1", trackIds: memberIds }],
      members,
    );

    const a = classify(inputA);
    const b = classify(inputB);
    expect(a).toEqual(b);
  });

  it("counts unclassifiable songs separately", () => {
    const memberIds = Array.from({ length: 10 }, (_, i) => `m${i}`);
    const members = memberIds.map((id) => makeTrack(id));
    // Liked song has no features — unclassifiable.
    const liked = makeTrack("liked1", { features: null });

    const result = classify(
      makeInput(
        [liked],
        [{ id: "p1", name: "P1", trackIds: memberIds }],
        members,
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stats.unclassifiable).toBe(1);
      expect(result.proposals.length).toBe(0);
    }
  });

  it("picks the highest-similarity playlist among multiple candidates", () => {
    const buildPlaylist = (
      id: string,
      feature: Partial<AudioFeatures>,
    ) => {
      const memberIds = Array.from({ length: 10 }, (_, i) => `${id}:${i}`);
      const members = memberIds.map((tid) =>
        makeTrack(tid, { features: makeFeatures(feature) }),
      );
      return {
        playlist: { id, name: id, trackIds: memberIds },
        members,
      };
    };

    const chill = buildPlaylist("chill", {
      energy: 0.2,
      valence: 0.3,
      tempo: 70,
    });
    const hype = buildPlaylist("hype", {
      energy: 0.95,
      valence: 0.8,
      tempo: 170,
    });

    // Clearly a hype song.
    const liked = makeTrack("liked1", {
      features: makeFeatures({
        energy: 0.92,
        valence: 0.85,
        tempo: 165,
      }),
    });

    const result = classify(
      makeInput(
        [liked],
        [chill.playlist, hype.playlist],
        [...chill.members, ...hype.members],
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposals.length).toBe(1);
      expect(result.proposals[0].playlistId).toBe("hype");
    }
  });
});
