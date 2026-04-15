/**
 * Last.fm API wrapper for track-level genre tags.
 *
 * Replaces Spotify's artist-level genres with per-track tags from Last.fm's
 * community-voted `track.getTopTags` endpoint. Tags are filtered through a
 * blocklist to strip junk (personal tags, meta-tags) while keeping genres,
 * sub-genres, moods, and vibes that help the classifier.
 *
 * Rate limit strategy:
 *   - 5 requests/second (Last.fm's documented limit)
 *   - Sequential loop with 200ms minimum spacing between dispatches
 *   - Stop on first 429, return partial results
 *   - Module-level cooldown tracking (same pattern as reccobeats.ts)
 *
 * Graceful degradation: if LASTFM_API_KEY is not set, all lookups return
 * empty results and the classifier falls back to Spotify artist genres.
 */

const BASE_URL = "https://ws.audioscrobbler.com/2.0";
const REQUEST_SPACING_MS = 200; // 5 req/sec
const MAX_TAGS_PER_TRACK = 8;
const MIN_TAG_COUNT = 10;

// ───────────────────── rate limit tracking ─────────────────────

let rateLimitedUntil = 0;

function isRateLimited(): boolean {
  return Date.now() < rateLimitedUntil;
}

function recordRateLimit(retryAfterSeconds: number) {
  const waitMs = Math.max(retryAfterSeconds, 10) * 1000;
  rateLimitedUntil = Date.now() + waitMs;
  console.warn(
    `[lastfm] rate limited — pausing for ${retryAfterSeconds}s (until ${new Date(rateLimitedUntil).toLocaleTimeString()})`,
  );
}

/** Returns ms until the rate limit cooldown expires, or 0 if not limited. */
export function getLastFmRateLimitWaitMs(): number {
  return Math.max(0, rateLimitedUntil - Date.now());
}

// ───────────────────── API key ─────────────────────

let apiKeyChecked = false;
let apiKey: string | null = null;

function getApiKey(): string | null {
  if (apiKey) return apiKey;
  if (apiKeyChecked) return null;
  apiKeyChecked = true;

  const key = process.env.LASTFM_API_KEY;
  if (!key) {
    console.warn(
      "[lastfm] LASTFM_API_KEY not set. Track-level genre tags disabled; falling back to Spotify artist genres.",
    );
    return null;
  }
  apiKey = key;
  return key;
}

// ───────────────────── tag normalisation ─────────────────────

function normalizeTag(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/hip\s*-?\s*hop/g, "hip-hop")
    .replace(/r\s*&\s*b/g, "r&b")
    .replace(/r\s*n\s*b/g, "r&b")
    .replace(/drum\s*(?:and|&|n)\s*bass/g, "drum and bass")
    .replace(/lo\s*-?\s*fi/g, "lo-fi")
    .replace(/synth\s*-?\s*pop/g, "synthpop")
    .replace(/synth\s*-?\s*wave/g, "synthwave")
    .replace(/post\s*-?\s*punk/g, "post-punk")
    .replace(/post\s*-?\s*rock/g, "post-rock")
    .replace(/post\s*-?\s*hardcore/g, "post-hardcore")
    .replace(/death\s*-?\s*core/g, "deathcore")
    .replace(/metal\s*-?\s*core/g, "metalcore")
    .replace(/pop\s*-?\s*punk/g, "pop punk")
    .replace(/nu\s*-?\s*metal/g, "nu metal")
    .replace(/j\s*-?\s*pop/g, "j-pop")
    .replace(/k\s*-?\s*pop/g, "k-pop")
    .replace(/c\s*-?\s*pop/g, "c-pop");
}

// ───────────────────── tag blocklist ─────────────────────

/**
 * Blocklist of junk tags to discard. We keep everything EXCEPT these
 * patterns — genres, sub-genres, moods, and vibes all pass through.
 *
 * Blocked categories:
 *   - Personal tags: "seen live", "favourite", "my playlist", etc.
 *   - Meta/format tags: "albums i own", "vinyl", "spotify", "single"
 *   - Decade/year tags: "00s", "2010s", "1990s", "80s music"
 *   - Artist-name tags (common on Last.fm, useless for genre classification)
 *   - Overly vague: "awesome", "cool", "good", "love", "best"
 */
const BLOCKED_PATTERNS = [
  // personal / meta
  /^seen live$/,
  /^favou?rite/,
  /^my /,
  /^i /,
  /^albums? i/,
  /^songs? i/,
  /^tracks? i/,
  /^played/,
  /^owned/,
  /^vinyl$/,
  /^cd$/,
  /^spotify$/,
  /^itunes$/,
  /^single$/,
  /^album$/,
  /^ep$/,
  /^lp$/,
  /^compilation$/,
  /^cover$/,
  /^remix$/,
  /^live$/,
  /^karaoke$/,

  // decades / years — "80s", "90s", "2000s", "1990s", "80s music", etc.
  /^\d{2,4}s?\s*(music)?$/,

  // overly vague praise / filler
  /^(awesome|amazing|cool|good|great|best|love[ds]?|nice|beautiful|perfect|brilliant|excellent|wonderful|incredible|fantastic|superb|outstanding|magnificent|the best)$/,

  // generic non-descriptive
  /^(check out|to listen|to buy|to check|todo|want|wish|need|must)$/,
  /^under \d/,

  // language identifiers (not genre)
  /^(english|french|german|spanish|japanese|korean|chinese|portuguese|italian|swedish|norwegian|finnish|dutch|arabic|hindi|russian)$/,

  // gender / demographic (not genre)
  /^(male|female|male vocalists?|female vocalists?|male singers?|female singers?)$/,

  // nationality-as-tag (not genre) — "british", "american", "australian", etc.
  /^(british|american|australian|canadian|irish|scottish|welsh|swedish|norwegian|finnish|icelandic|german|french|belgian|dutch|italian|spanish|brazilian|mexican|colombian|argentinian|japanese|korean|chinese|taiwanese|indian|nigerian|south african|new zealand)$/,
];

function isBlockedTag(tag: string): boolean {
  // Short tags (1-2 chars) are almost always noise.
  if (tag.length <= 2) return true;
  return BLOCKED_PATTERNS.some((p) => p.test(tag));
}

// ───────────────────── API call ─────────────────────

type LastFmResponse = {
  toptags?: {
    tag?: Array<{ name: string; count: number }>;
  };
  error?: number;
  message?: string;
};

export type TrackTagResult =
  | { ok: true; tags: string[] }
  | { ok: false; reason: "not_found" | "error" | "rate_limited" };

class RateLimitError extends Error {
  constructor(public retryAfter: number) {
    super("Rate limited");
  }
}

async function fetchTopTags(
  artistName: string,
  trackName: string,
  key: string,
): Promise<TrackTagResult> {
  if (isRateLimited()) {
    return { ok: false, reason: "rate_limited" };
  }

  const params = new URLSearchParams({
    method: "track.gettoptags",
    artist: artistName,
    track: trackName,
    api_key: key,
    format: "json",
  });

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}?${params}`);
  } catch (err) {
    console.warn("[lastfm] network error:", (err as Error).message);
    return { ok: false, reason: "error" };
  }

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("retry-after") ?? "30", 10);
    recordRateLimit(retryAfter);
    throw new RateLimitError(retryAfter);
  }

  if (!res.ok) {
    console.warn(`[lastfm] HTTP ${res.status} for "${artistName} - ${trackName}"`);
    return { ok: false, reason: "error" };
  }

  let data: LastFmResponse;
  try {
    data = (await res.json()) as LastFmResponse;
  } catch {
    return { ok: false, reason: "error" };
  }

  // Last.fm returns 200 with { error: 6 } for not-found tracks.
  if (data.error) {
    return { ok: false, reason: "not_found" };
  }

  const rawTags = data.toptags?.tag;
  if (!rawTags || rawTags.length === 0) {
    return { ok: true, tags: [] };
  }

  // Filter pipeline: normalize → blocklist → count threshold → top N
  const filtered: Array<{ tag: string; count: number }> = [];
  for (const t of rawTags) {
    if (typeof t.name !== "string" || typeof t.count !== "number") continue;
    if (t.count < MIN_TAG_COUNT) continue;
    const normalized = normalizeTag(t.name);
    if (!isBlockedTag(normalized)) {
      filtered.push({ tag: normalized, count: t.count });
    }
  }

  // Deduplicate (normalization can collapse two raw tags into one).
  const seen = new Map<string, number>();
  for (const { tag, count } of filtered) {
    const existing = seen.get(tag);
    if (existing == null || count > existing) {
      seen.set(tag, count);
    }
  }

  const tags = Array.from(seen.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TAGS_PER_TRACK)
    .map(([tag]) => tag);

  return { ok: true, tags };
}

// ───────────────────── batch fetcher ─────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch track-level genre tags for a batch of tracks.
 *
 * Sequential loop with 200ms minimum spacing between requests (exactly
 * 5/sec). Overlaps the sleep with the HTTP request so we don't waste
 * time waiting when the response is fast. Stops on first 429, returning
 * partial results.
 */
export async function fetchTrackTags(
  tracks: Array<{
    artistName: string;
    trackName: string;
    spotifyTrackId: string;
  }>,
): Promise<Map<string, TrackTagResult>> {
  const out = new Map<string, TrackTagResult>();
  if (tracks.length === 0) return out;

  const key = getApiKey();
  if (!key) return out;

  let lastLoggedCount = 0;

  for (let i = 0; i < tracks.length; i++) {
    if (isRateLimited()) break;

    const t = tracks[i];

    // Fire the request and the rate-limit sleep concurrently so that
    // network latency overlaps with the 200ms pause. We always wait
    // at least 200ms between *dispatches* — if the request is faster,
    // the sleep absorbs the difference; if it's slower, we proceed
    // immediately after the response.
    const sleepPromise = sleep(REQUEST_SPACING_MS);

    try {
      const result = await fetchTopTags(t.artistName, t.trackName, key);
      out.set(t.spotifyTrackId, result);
    } catch (err) {
      if (err instanceof RateLimitError) {
        break; // stop the entire batch
      }
      console.warn(
        `[lastfm] unexpected error for "${t.artistName} - ${t.trackName}":`,
        (err as Error).message,
      );
      out.set(t.spotifyTrackId, { ok: false, reason: "error" });
    }

    await sleepPromise; // ensure minimum 200ms between dispatches

    // Log progress every 200 tracks.
    const succeeded = i + 1;
    if (succeeded - lastLoggedCount >= 200) {
      const withTags = Array.from(out.values()).filter(
        (r) => r.ok && r.tags.length > 0,
      ).length;
      console.log(
        `[lastfm] progress: ${succeeded}/${tracks.length} looked up, ${withTags} have tags`,
      );
      lastLoggedCount = succeeded;
    }
  }

  const succeeded = Array.from(out.values()).filter((r) => r.ok).length;
  const withTags = Array.from(out.values()).filter(
    (r) => r.ok && r.tags.length > 0,
  ).length;
  console.log(
    `[lastfm] done: ${succeeded}/${tracks.length} looked up, ${withTags} have usable tags`,
  );

  return out;
}

/** Exposed for tests. */
export function _resetLastFmInternal(): void {
  rateLimitedUntil = 0;
  apiKeyChecked = false;
  apiKey = null;
}
