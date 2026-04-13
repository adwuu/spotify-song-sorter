"use server";

/**
 * Server actions for the sync pipeline.
 *
 * Two-phase design (Issue 4A):
 *   1. hydrateAction — idempotent fetch + cache, resumable if interrupted
 *   2. classifyAction — pure in-memory computation on cached data
 *   3. applyAction — writes proposals back to Spotify playlists
 *
 * Safety invariants:
 *   - hydrateAction + classifyAction are read-only (Safety #1)
 *   - applyAction never calls DELETE endpoints (Safety #3)
 *   - Classifier filters tracks already in any owned playlist (Safety #2)
 */

import {
  getSpotify,
  fetchAllLikedSongs,
  fetchOwnedPlaylists,
  fetchAllPlaylistTracks,
  fetchArtistGenres,
  addTracksToPlaylist,
} from "@/lib/spotify";
import {
  mgetFeatures,
  msetFeatures,
  mgetGenres,
  msetGenres,
  isTombstone,
  type AudioFeatures,
} from "@/lib/cache";
import { hydrateFeatures, getRateLimitWaitMs } from "@/lib/reccobeats";
import {
  classify,
  type TrackInput,
  type PlaylistInput,
  type ClassifyResult,
  type Proposal,
} from "@/lib/classifier";
import type { Track } from "@spotify/web-api-ts-sdk";

// Soft time budget per hydrate call, so a cold first run on a large
// library fits comfortably within the Vercel 300s function timeout
// and the browser can loop with progress feedback.
// Allow up to 5 minutes per hydrate call. For ~2000 tracks with ReccoBeats
// rate limits (~12s cooldown every ~15 chunks of 20), a full cold hydrate
// takes ~3-4 minutes. The user asked to do it all in one Sync click.
const HYDRATE_TIME_BUDGET_MS = 5 * 60 * 1000;

// ─── in-memory Spotify catalog cache ───
// Survives across server action calls within the same dev process.
// Avoids re-fetching the entire library on every Sync click, which
// is the #1 cause of Spotify rate-limit exhaustion.
let catalogCache: {
  sourceSongs: Track[];
  targetPlaylists: { id: string; name: string }[];
  playlistTracksMap: Map<string, Track[]>;
  allTracks: Map<string, Track>;
  allArtistIds: Set<string>;
  configKey: string;
  fetchedAt: number;
} | null = null;

// Cache catalog for 24 hours — effectively "forever" within a dev session.
// Your library doesn't change between Sync clicks. The user can restart
// the dev server to force a refresh.
const CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Store the last-used sync config so classifyAction can reuse it. */
let lastSyncConfig: SyncConfig | null = null;

function configKey(config: SyncConfig): string {
  return JSON.stringify({
    s: config.sourcePlaylistIds.sort(),
    l: config.includeLikedSongs,
    t: config.targetPlaylistIds.sort(),
  });
}

// ─────────────────────────── playlist picker ───────────────────────────

export type PlaylistInfo = {
  id: string;
  name: string;
  trackCount: number;
  imageUrl: string | null;
};

let pickerCache: { playlists: PlaylistInfo[]; fetchedAt: number } | null = null;

/**
 * Fetch the user's owned playlists for the picker UI.
 * Cached for the session so it doesn't burn API calls on repeated opens.
 */
export async function fetchPlaylistsAction(): Promise<PlaylistInfo[]> {
  if (pickerCache && Date.now() - pickerCache.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return pickerCache.playlists;
  }

  const api = await getSpotify();
  const userId = process.env.SPOTIFY_USER_ID;
  if (!userId) throw new Error("SPOTIFY_USER_ID env var is required");

  const playlists = await fetchOwnedPlaylists(api, userId);
  const result = playlists.map((p) => ({
    id: p.id,
    name: p.name,
    trackCount: p.tracks?.total ?? 0,
    imageUrl: p.images?.[0]?.url ?? null,
  }));

  pickerCache = { playlists: result, fetchedAt: Date.now() };
  return result;
}

/**
 * Config passed from the playlist picker to hydrate/classify.
 */
export type SyncConfig = {
  /** Playlist IDs to sort FROM (source). Empty = use Liked Songs. */
  sourcePlaylistIds: string[];
  /** Whether to include Liked Songs as a source. */
  includeLikedSongs: boolean;
  /** Playlist IDs to sort INTO (targets). */
  targetPlaylistIds: string[];
};

// ─────────────────────────── types ───────────────────────────

export type HydrateStats = {
  totalTracks: number;
  cachedTracks: number;
  totalArtists: number;
  cachedArtists: number;
};

export type HydrateResult = {
  done: boolean;
  progress: { hydrated: number; total: number };
  stats: HydrateStats;
  /** If rate-limited, how many seconds to wait before calling again. */
  cooldownSeconds?: number;
};

// ─────────────────────────── helpers ───────────────────────────

function trackToInput(
  track: Track,
  features: AudioFeatures | null,
): TrackInput {
  return {
    id: track.id,
    name: track.name,
    artistNames: track.artists.map((a) => a.name),
    artistIds: track.artists.map((a) => a.id),
    albumArtUrl:
      track.album?.images?.length > 0
        ? track.album.images[track.album.images.length - 1].url
        : null,
    features,
  };
}

// ─────────────────────────── hydrate ───────────────────────────

/**
 * Phase 1: fetch all the data we need from Spotify, then hydrate audio
 * features and artist genres from ReccoBeats + Spotify into the cache.
 *
 * Idempotent: safe to call repeatedly. Uses a soft time budget so large
 * libraries can be hydrated across multiple calls.
 */
export async function hydrateAction(config: SyncConfig): Promise<HydrateResult> {
  const started = Date.now();
  lastSyncConfig = config;
  const ck = configKey(config);

  // Use cached catalog if fresh AND same config.
  if (
    catalogCache &&
    catalogCache.configKey === ck &&
    Date.now() - catalogCache.fetchedAt < CATALOG_CACHE_TTL_MS
  ) {
    console.log(
      `[hydrate] using cached catalog (${catalogCache.sourceSongs.length} source songs, ${catalogCache.targetPlaylists.length} targets)`,
    );
  } else {
    let api;
    try {
      api = await getSpotify();
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg.toLowerCase().includes("rate limit")) {
        throw new Error("Spotify rate limit hit. Wait a few minutes, then click Sync again.");
      }
      throw err;
    }

    const userId = process.env.SPOTIFY_USER_ID;
    if (!userId) throw new Error("SPOTIFY_USER_ID env var is required");

    // Fetch source songs (Liked Songs + any source playlists).
    const sourceSongs: Track[] = [];
    try {
      if (config.includeLikedSongs) {
        const liked = await fetchAllLikedSongs(api);
        sourceSongs.push(...liked);
      }
      if (config.sourcePlaylistIds.length > 0) {
        const sourceTracksMap = await fetchAllPlaylistTracks(api, config.sourcePlaylistIds);
        for (const tracks of sourceTracksMap.values()) {
          sourceSongs.push(...tracks);
        }
      }
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg.toLowerCase().includes("rate limit")) {
        throw new Error("Spotify rate limit hit. Wait a few minutes, then click Sync again.");
      }
      throw err;
    }

    // Fetch target playlist tracks.
    const ownedPlaylists = await fetchOwnedPlaylists(api, userId);
    const targetPlaylists = ownedPlaylists
      .filter((p) => config.targetPlaylistIds.includes(p.id))
      .map((p) => ({ id: p.id, name: p.name }));

    let playlistTracksMap;
    try {
      playlistTracksMap = await fetchAllPlaylistTracks(
        api,
        config.targetPlaylistIds,
      );
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg.toLowerCase().includes("rate limit")) {
        throw new Error("Spotify rate limit hit. Wait a few minutes, then click Sync again.");
      }
      throw err;
    }

    console.log(
      `[hydrate] fetched ${sourceSongs.length} source songs, ${targetPlaylists.length} target playlists`,
    );
    for (const [pid, tracks] of playlistTracksMap) {
      if (tracks.length > 0) {
        console.log(`  target ${pid}: ${tracks.length} tracks`);
      }
    }

    const allTracks = new Map<string, Track>();
    for (const t of sourceSongs) allTracks.set(t.id, t);
    for (const tracks of playlistTracksMap.values()) {
      for (const t of tracks) allTracks.set(t.id, t);
    }

    const allArtistIds = new Set<string>();
    for (const t of allTracks.values()) {
      for (const a of t.artists) allArtistIds.add(a.id);
    }

    catalogCache = {
      sourceSongs,
      targetPlaylists,
      playlistTracksMap,
      allTracks,
      allArtistIds,
      configKey: ck,
      fetchedAt: Date.now(),
    };
  }

  const { allTracks, allArtistIds } = catalogCache;

  // 3. Cache check — features.
  const trackIdList = Array.from(allTracks.keys());
  const featuresCache = await mgetFeatures(trackIdList);
  const featureMisses: string[] = [];
  for (let i = 0; i < trackIdList.length; i++) {
    if (featuresCache[i] == null) featureMisses.push(trackIdList[i]);
  }

  // 4. Cache check — genres.
  const artistIdList = Array.from(allArtistIds);
  const genresCache = await mgetGenres(artistIdList);
  const genreMisses: string[] = [];
  for (let i = 0; i < artistIdList.length; i++) {
    if (genresCache[i] == null) genreMisses.push(artistIdList[i]);
  }

  const stats: HydrateStats = {
    totalTracks: trackIdList.length,
    cachedTracks: trackIdList.length - featureMisses.length,
    totalArtists: artistIdList.length,
    cachedArtists: artistIdList.length - genreMisses.length,
  };

  console.log(
    `[hydrate] cache status: ${trackIdList.length - featureMisses.length} cached, ${featureMisses.length} misses out of ${trackIdList.length} total`,
  );

  // Early exit: nothing to hydrate (genres are best-effort so not blocking).
  if (featureMisses.length === 0) {
    return {
      done: true,
      progress: { hydrated: stats.cachedTracks, total: stats.totalTracks },
      stats,
    };
  }

  // 5. Hydrate features in small chunks. Process up to MAX_CHUNKS_PER_CALL
  //    chunks per server action call, then return so the UI can update the
  //    progress bar. The browser loops and calls us again for the next batch.
  const CHUNK = 20;
  const MAX_CHUNKS_PER_CALL = 5; // ~100 tracks per call → UI updates every few seconds
  let hydratedThisCall = 0;
  let chunksProcessed = 0;

  for (let i = 0; i < featureMisses.length; i += CHUNK) {
    // Return for UI update after processing MAX_CHUNKS_PER_CALL chunks.
    if (chunksProcessed >= MAX_CHUNKS_PER_CALL) {
      const featuresCache2 = await mgetFeatures(trackIdList);
      const cachedNow = featuresCache2.filter((v) => v != null).length;
      return {
        done: false,
        progress: { hydrated: cachedNow, total: trackIdList.length },
        stats: { ...stats, cachedTracks: cachedNow },
      };
    }

    // If ReccoBeats is in cooldown, return with cooldown info.
    const waitMs = getRateLimitWaitMs();
    if (waitMs > 0) {
      const cooldownSeconds = Math.ceil(waitMs / 1000) + 1;
      const featuresCache2 = await mgetFeatures(trackIdList);
      const cachedNow = featuresCache2.filter((v) => v != null).length;
      return {
        done: false,
        progress: { hydrated: cachedNow, total: trackIdList.length },
        stats: { ...stats, cachedTracks: cachedNow },
        cooldownSeconds,
      };
    }

    if (Date.now() - started > HYDRATE_TIME_BUDGET_MS) break;

    const chunk = featureMisses.slice(i, i + CHUNK);
    const results = await hydrateFeatures(chunk);

    const writeEntries: Array<{
      spotifyTrackId: string;
      value: AudioFeatures | { unavailable: true };
    }> = [];
    for (const [spotifyId, result] of results) {
      if (result.ok) {
        writeEntries.push({ spotifyTrackId: spotifyId, value: result.features });
        hydratedThisCall++;
      } else if (result.reason === "not_found") {
        writeEntries.push({
          spotifyTrackId: spotifyId,
          value: { unavailable: true },
        });
        hydratedThisCall++;
      }
    }
    await msetFeatures(writeEntries);
    chunksProcessed++;
  }

  // 6. Hydrate genres (best-effort — does NOT block done status).
  //    Spotify's per-app rate limit is very tight on new dev-mode apps.
  //    After fetching 2000+ playlist track pages, the artist calls almost
  //    always hit the wall. We try a small batch; whatever we get is cached
  //    in memory for the classify step. On subsequent syncs the rate limit
  //    resets and more genres fill in.
  if (Date.now() - started < HYDRATE_TIME_BUDGET_MS && genreMisses.length > 0) {
    // Only attempt a tiny batch (5) per hydrate cycle. No retries — if
    // Spotify is rate-limiting, these will all fail fast (~1s total) and
    // we move on. Each subsequent Sync picks up more as the limit resets.
    const genreBatch = genreMisses.slice(0, 5);
    try {
      const genreApi = await getSpotify();
      const genreMap = await fetchArtistGenres(genreApi, genreBatch);
      const writeEntries: Array<{ spotifyArtistId: string; genres: string[] }> = [];
      for (const [aid, genres] of genreMap) {
        writeEntries.push({ spotifyArtistId: aid, genres });
      }
      await msetGenres(writeEntries);
      const fetched = writeEntries.filter((e) => e.genres.length > 0).length;
      if (fetched > 0) {
        console.log(`[hydrate] cached genres for ${fetched} artists`);
      }
    } catch {
      // Rate limited — that's fine, genres are best-effort.
    }
  }

  // Recompute feature cache coverage (genres are NOT blocking).
  const featuresCache2 = await mgetFeatures(trackIdList);
  const cachedTracksNow = featuresCache2.filter((v) => v != null).length;

  const done = cachedTracksNow === trackIdList.length;

  return {
    done,
    progress: { hydrated: cachedTracksNow, total: trackIdList.length },
    stats: {
      totalTracks: trackIdList.length,
      cachedTracks: cachedTracksNow,
      totalArtists: artistIdList.length,
      cachedArtists: artistIdList.length - genreMisses.length,
    },
  };
}

// ─────────────────────────── classify ───────────────────────────

/**
 * Phase 2: load cached data + run the classifier.
 *
 * Pure computation, fast. Assumes hydrateAction has already populated
 * the cache (missing entries are treated as unclassifiable).
 */
export async function classifyAction(): Promise<ClassifyResult> {
  if (!catalogCache || !lastSyncConfig) {
    throw new Error("Catalog not loaded. Click Sync first.");
  }

  const { sourceSongs, targetPlaylists, playlistTracksMap, allTracks } =
    catalogCache;

  // Pull features from cache.
  const trackIdList = Array.from(allTracks.keys());
  const featuresCache = await mgetFeatures(trackIdList);
  const featuresById = new Map<string, AudioFeatures | null>();
  for (let i = 0; i < trackIdList.length; i++) {
    const v = featuresCache[i];
    if (v == null || isTombstone(v)) {
      featuresById.set(trackIdList[i], null);
    } else {
      featuresById.set(trackIdList[i], v);
    }
  }

  // Pull genres from cache.
  const allArtistIds = new Set<string>();
  for (const t of allTracks.values()) {
    for (const a of t.artists) allArtistIds.add(a.id);
  }
  const artistIdList = Array.from(allArtistIds);
  const genresCache = await mgetGenres(artistIdList);
  const genresByArtistId = new Map<string, string[]>();
  for (let i = 0; i < artistIdList.length; i++) {
    const g = genresCache[i];
    genresByArtistId.set(artistIdList[i], g ?? []);
  }

  // Convert to classifier inputs.
  const tracksById = new Map<string, TrackInput>();
  for (const [id, t] of allTracks) {
    tracksById.set(id, trackToInput(t, featuresById.get(id) ?? null));
  }

  const likedInputs: TrackInput[] = sourceSongs.map(
    (t) => tracksById.get(t.id) ?? trackToInput(t, null),
  );

  const playlistInputs: PlaylistInput[] = targetPlaylists.map((p) => ({
    id: p.id,
    name: p.name,
    trackIds: (playlistTracksMap.get(p.id) ?? []).map((t) => t.id),
  }));

  // Log diagnostic info before classifying.
  const withFeatures = Array.from(featuresById.values()).filter(
    (v) => v != null,
  ).length;
  console.log(
    `[classify] ${likedInputs.length} source songs, ` +
    `${playlistInputs.length} playlists, ` +
    `${tracksById.size} unique tracks, ` +
    `${withFeatures} have audio features (${tracksById.size - withFeatures} missing)`,
  );

  const result = classify({
    likedSongs: likedInputs,
    playlists: playlistInputs,
    tracksById,
    genresByArtistId,
  });

  if (result.ok) {
    console.log(
      `[classify] result: ${result.stats.proposed} proposals, ` +
      `${result.stats.alreadyPlaced} already placed, ` +
      `${result.stats.unclassifiable} unclassifiable`,
    );
  } else {
    console.log(`[classify] result: ${result.error} — ${result.message}`);
  }

  return result;
}

// ─────────────────────────── apply ───────────────────────────

export type ApplyResult = {
  totalAdded: number;
  results: Array<{
    playlistId: string;
    playlistName: string;
    added: number;
    error?: string;
  }>;
};

/**
 * Phase 3: write approved proposals back to Spotify.
 *
 * Per-playlist try/catch: if one playlist fails, others still apply.
 * Never calls DELETE endpoints (Safety #3).
 */
export async function applyAction(proposals: Proposal[]): Promise<ApplyResult> {
  const api = await getSpotify();

  // Group by playlist.
  const byPlaylist = new Map<string, { name: string; trackUris: string[] }>();
  for (const p of proposals) {
    if (!byPlaylist.has(p.playlistId)) {
      byPlaylist.set(p.playlistId, { name: p.playlistName, trackUris: [] });
    }
    byPlaylist.get(p.playlistId)!.trackUris.push(`spotify:track:${p.trackId}`);
  }

  const results: ApplyResult["results"] = [];
  let totalAdded = 0;

  for (const [playlistId, { name, trackUris }] of byPlaylist) {
    try {
      const added = await addTracksToPlaylist(api, playlistId, trackUris);
      totalAdded += added;
      results.push({ playlistId, playlistName: name, added });
    } catch (err) {
      results.push({
        playlistId,
        playlistName: name,
        added: 0,
        error: (err as Error).message,
      });
    }
  }

  return { totalAdded, results };
}
