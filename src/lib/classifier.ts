/**
 * Classifier: learn from existing playlist contents, assign new liked
 * songs to their best match by cosine similarity over a combined
 * audio-feature + genre feature vector.
 *
 * All logic in one file (Issue 2A): config, vector construction,
 * centroid + tightness, assignment. ~250 lines total.
 */

import type { AudioFeatures } from "./cache";

// ─────────────────────────── tunable constants ───────────────────────────

/** Minimum cosine similarity for any assignment to be made. */
export const GLOBAL_THRESHOLD = 0.75;

/** Relative weight of the genre block vs the audio feature block. */
export const GENRE_WEIGHT = 1.0;

/** Minimum tracks in a playlist to build a reliable centroid from. */
export const MIN_PLAYLIST_SIZE = 10;

/** Hard-coded playlist IDs to skip entirely. Empty by default. */
export const EXCLUDED_PLAYLIST_IDS: readonly string[] = [];

// ─────────────────────────── types ───────────────────────────

export type TrackInput = {
  /** Spotify track ID */
  id: string;
  /** Display name */
  name: string;
  /** Artist display names, comma-joinable */
  artistNames: string[];
  /** Spotify artist IDs used to look up genres */
  artistIds: string[];
  /** Album art URL (smallest) */
  albumArtUrl: string | null;
  /** ReccoBeats audio features, or null if unavailable */
  features: AudioFeatures | null;
};

export type PlaylistInput = {
  id: string;
  name: string;
  /** Spotify track IDs that belong to this playlist currently */
  trackIds: string[];
};

export type ClassifyInput = {
  likedSongs: TrackInput[];
  playlists: PlaylistInput[];
  /** Full lookup map by spotify track ID (union of liked + playlist tracks) */
  tracksById: Map<string, TrackInput>;
  /** Genre lookup: artist ID → list of genre tags */
  genresByArtistId: Map<string, string[]>;
};

export type Proposal = {
  trackId: string;
  trackName: string;
  artistNames: string[];
  albumArtUrl: string | null;
  playlistId: string;
  playlistName: string;
  similarity: number;
};

export type SkippedSong = {
  trackId: string;
  trackName: string;
  artistNames: string[];
  albumArtUrl: string | null;
  reason: "already_placed" | "no_features" | "below_threshold";
  /** Human-readable detail, e.g. "Already in: Workout Mix" */
  detail: string;
};

export type ClassifyResult =
  | {
      ok: true;
      proposals: Proposal[];
      skipped: SkippedSong[];
      stats: {
        totalLiked: number;
        alreadyPlaced: number;
        unclassifiable: number;
        proposed: number;
        belowThreshold: number;
      };
    }
  | {
      ok: false;
      error: "no_eligible_playlists";
      message: string;
    };

// ─────────────────────────── vector math ───────────────────────────

type Vec = Float64Array;

/** Audio-feature block is always 8 dimensions, in this fixed order. */
const AUDIO_DIMS = 8;

/**
 * Build the global genre vocabulary across every artist we've seen.
 * Each unique genre tag gets a stable index in the returned array.
 */
function buildGenreVocabulary(
  genresByArtistId: Map<string, string[]>,
): string[] {
  const set = new Set<string>();
  for (const genres of genresByArtistId.values()) {
    for (const g of genres) set.add(g);
  }
  return Array.from(set).sort(); // stable order for deterministic results
}

/**
 * Construct a feature vector for a single track. NaN guards are applied
 * throughout — any missing / non-finite value becomes 0.
 *
 * Layout: [energy, valence, danceability, acousticness, instrumentalness,
 *          speechiness, liveness, tempo/200, genre_0, genre_1, ...]
 *
 * Each genre dimension is multiplied by (GENRE_WEIGHT / sqrt(G)) so the
 * genre block's L2 norm contribution matches the audio block in aggregate.
 */
function buildVector(
  track: TrackInput,
  genresByArtistId: Map<string, string[]>,
  genreVocab: string[],
  genreIndex: Map<string, number>,
): Vec {
  const G = genreVocab.length;
  const v = new Float64Array(AUDIO_DIMS + G);

  // Audio block with NaN guards.
  const f = track.features;
  const safe = (x: number | undefined): number =>
    typeof x === "number" && Number.isFinite(x) ? x : 0;

  if (f) {
    v[0] = safe(f.energy);
    v[1] = safe(f.valence);
    v[2] = safe(f.danceability);
    v[3] = safe(f.acousticness);
    v[4] = safe(f.instrumentalness);
    v[5] = safe(f.speechiness);
    v[6] = safe(f.liveness);
    // Tempo normalized to ~[0, 1] range (200 BPM ceiling).
    v[7] = Math.max(0, Math.min(1, safe(f.tempo) / 200));
  }
  // If features are null, leave the audio block as zeros — the math
  // still works, it just contributes nothing to similarity.

  // Genre block (one-hot for any genre ANY of the track's artists have).
  if (G > 0) {
    const w = GENRE_WEIGHT / Math.sqrt(G);
    const seen = new Set<number>();
    for (const aid of track.artistIds) {
      const genres = genresByArtistId.get(aid);
      if (!genres) continue;
      for (const g of genres) {
        const idx = genreIndex.get(g);
        if (idx !== undefined) seen.add(idx);
      }
    }
    for (const idx of seen) v[AUDIO_DIMS + idx] = w;
  }

  return v;
}

/** Elementwise mean of a list of vectors (all same length). */
function mean(vecs: Vec[]): Vec {
  const n = vecs.length;
  if (n === 0) return new Float64Array(0);
  const len = vecs[0].length;
  const out = new Float64Array(len);
  for (const v of vecs) {
    for (let i = 0; i < len; i++) out[i] += v[i];
  }
  for (let i = 0; i < len; i++) out[i] /= n;
  return out;
}

function norm(v: Vec): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

function dot(a: Vec, b: Vec): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Cosine similarity with a precomputed B norm (Issue 16A optimization). */
function cosineWithPrecomputedBNorm(a: Vec, b: Vec, bNorm: number): number {
  const an = norm(a);
  if (an === 0 || bNorm === 0) return 0;
  return dot(a, b) / (an * bNorm);
}

// ─────────────────────────── centroids ───────────────────────────

type Centroid = {
  playlistId: string;
  playlistName: string;
  vector: Vec;
  /** Cached norm of vector. */
  vectorNorm: number;
  /** Mean intra-playlist cosine similarity — the "tightness" signal. */
  tightness: number;
  /** Set of track IDs in this playlist (for secondary dedup check). */
  memberIds: Set<string>;
};

function buildCentroid(
  playlist: PlaylistInput,
  memberVectors: Vec[],
): Centroid {
  const c = mean(memberVectors);
  const cNorm = norm(c);

  // Tightness = mean cosine similarity of members to centroid.
  let sum = 0;
  let count = 0;
  for (const v of memberVectors) {
    const s = cosineWithPrecomputedBNorm(v, c, cNorm);
    if (Number.isFinite(s)) {
      sum += s;
      count++;
    }
  }
  const tightness = count > 0 ? sum / count : 0;

  return {
    playlistId: playlist.id,
    playlistName: playlist.name,
    vector: c,
    vectorNorm: cNorm,
    tightness,
    memberIds: new Set(playlist.trackIds),
  };
}

// ─────────────────────────── classify ───────────────────────────

export function classify(input: ClassifyInput): ClassifyResult {
  const {
    likedSongs,
    playlists,
    tracksById,
    genresByArtistId,
  } = input;

  // Filter playlists by eligibility:
  //   - not in EXCLUDED_PLAYLIST_IDS
  //   - at least MIN_PLAYLIST_SIZE tracks
  const excluded = new Set(EXCLUDED_PLAYLIST_IDS);
  const eligible = playlists.filter(
    (p) => !excluded.has(p.id) && p.trackIds.length >= MIN_PLAYLIST_SIZE,
  );

  if (eligible.length === 0) {
    return {
      ok: false,
      error: "no_eligible_playlists",
      message:
        "You need at least one owned playlist with 10+ tracks to sort into. Add some songs to your playlists first.",
    };
  }

  // Build "already placed" set = every track ID in any eligible playlist.
  // (Safety Guarantee #2 primary layer.)
  const alreadyPlaced = new Set<string>();
  for (const p of eligible) {
    for (const id of p.trackIds) alreadyPlaced.add(id);
  }

  // Build genre vocabulary from every known artist.
  const genreVocab = buildGenreVocabulary(genresByArtistId);
  const genreIndex = new Map<string, number>();
  genreVocab.forEach((g, i) => genreIndex.set(g, i));

  // Build vectors for every unique track we know about.
  const vectors = new Map<string, Vec>();
  for (const [id, t] of tracksById) {
    vectors.set(id, buildVector(t, genresByArtistId, genreVocab, genreIndex));
  }

  // Build centroids for each eligible playlist.
  const centroids: Centroid[] = [];
  for (const p of eligible) {
    const memberVecs: Vec[] = [];
    for (const tid of p.trackIds) {
      const v = vectors.get(tid);
      if (v) memberVecs.push(v);
    }
    if (memberVecs.length < MIN_PLAYLIST_SIZE) continue;
    centroids.push(buildCentroid(p, memberVecs));
  }

  if (centroids.length === 0) {
    return {
      ok: false,
      error: "no_eligible_playlists",
      message:
        "No playlist has enough tracks with known audio features to build a centroid.",
    };
  }

  // Build reverse lookup: trackId → list of playlist names it's already in.
  const trackToPlaylists = new Map<string, string[]>();
  for (const p of eligible) {
    for (const tid of p.trackIds) {
      const list = trackToPlaylists.get(tid);
      if (list) list.push(p.name);
      else trackToPlaylists.set(tid, [p.name]);
    }
  }

  // Assign — a song can be proposed for MULTIPLE playlists, as long as
  // it's not already in that specific playlist. This replaces the old
  // "skip if in any playlist" logic.
  const proposals: Proposal[] = [];
  const skipped: SkippedSong[] = [];
  let alreadyPlacedCount = 0;
  let unclassifiable = 0;
  let belowThreshold = 0;

  for (const song of likedSongs) {
    const base = {
      trackId: song.id,
      trackName: song.name,
      artistNames: song.artistNames,
      albumArtUrl: song.albumArtUrl,
    };

    const songVec = vectors.get(song.id);
    if (!songVec || song.features == null) {
      unclassifiable++;
      skipped.push({
        ...base,
        reason: "no_features",
        detail: "ReccoBeats doesn't have audio features for this track",
      });
      continue;
    }

    // If the song is already in ANY playlist, skip it. Show all playlists
    // it's in so the user can see where it landed.
    if (alreadyPlaced.has(song.id)) {
      alreadyPlacedCount++;
      const plNames = trackToPlaylists.get(song.id) ?? ["unknown playlist"];
      skipped.push({
        ...base,
        reason: "already_placed",
        detail: `Already in: ${plNames.join(", ")}`,
      });
      continue;
    }

    let bestSim = -Infinity;
    let bestCentroid: Centroid | null = null;
    for (const c of centroids) {
      const sim = cosineWithPrecomputedBNorm(songVec, c.vector, c.vectorNorm);
      if (sim > bestSim) {
        bestSim = sim;
        bestCentroid = c;
      }
    }

    if (!bestCentroid || !Number.isFinite(bestSim)) {
      belowThreshold++;
      skipped.push({
        ...base,
        reason: "below_threshold",
        detail: "No playlist matched",
      });
      continue;
    }

    const threshold = Math.max(GLOBAL_THRESHOLD, 0.9 * bestCentroid.tightness);
    if (bestSim < threshold) {
      belowThreshold++;
      skipped.push({
        ...base,
        reason: "below_threshold",
        detail: `Best match: ${bestCentroid.playlistName} (${(bestSim * 100).toFixed(0)}% — needs ${(threshold * 100).toFixed(0)}%)`,
      });
      continue;
    }

    proposals.push({
      ...base,
      playlistId: bestCentroid.playlistId,
      playlistName: bestCentroid.playlistName,
      similarity: bestSim,
    });
  }

  // Sort proposals by similarity descending.
  proposals.sort((a, b) => b.similarity - a.similarity);

  return {
    ok: true,
    proposals,
    skipped,
    stats: {
      totalLiked: likedSongs.length,
      alreadyPlaced: alreadyPlacedCount,
      unclassifiable,
      proposed: proposals.length,
      belowThreshold,
    },
  };
}

// Exposed for tests.
export const _internal = {
  buildVector,
  buildCentroid,
  buildGenreVocabulary,
  mean,
  norm,
  cosineWithPrecomputedBNorm,
};
