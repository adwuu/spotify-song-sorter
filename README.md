# Spotify Sorter

Auto-sort your Liked Songs into playlists.

You dump songs into Liked Songs. This app analyses each one — audio features, genres — and figures out which of your existing playlists it belongs in. It builds a vector profile for each playlist, compares every unsorted song against those profiles using cosine similarity, and proposes assignments you can review before anything gets written.

Three phases: **hydrate** (fetch tracks + audio features), **classify** (compute centroids, score similarity), **apply** (write approved assignments to Spotify). The first two are read-only and can be re-run freely.

## How it works

1. Pick your source playlists (Liked Songs + whatever else) and target playlists
2. The app fetches every track's audio features (energy, valence, danceability, tempo, etc.) and artist genres
3. Each target playlist gets a centroid — a mean vector representing its typical sound
4. Every unsorted song is scored against each centroid; songs above the similarity threshold get proposed
5. You review the proposals and hit apply — only then does anything touch your Spotify library

The classifier uses adaptive thresholds: tight playlists (where everything already sounds alike) demand higher similarity scores. Songs can be proposed for multiple unrelated playlists. Songs already in a target playlist are skipped.

## Tech stack

- **Next.js 16** with App Router and Server Actions
- **React 19**, **Tailwind CSS 4**, **TypeScript 5**
- **Spotify Web API** via `@spotify/web-api-ts-sdk`
- **ReccoBeats API** for audio features (Spotify deprecated their audio-features endpoint)
- **Upstash Redis** for caching features and genres across sessions (optional — falls back to in-memory)
- **Vitest** for tests

## Setup

### Prerequisites

- Node.js 22+
- A Spotify Developer app at [developer.spotify.com](https://developer.spotify.com)
  - Add `http://127.0.0.1:8888/callback` as a redirect URI in the app settings

### 1. Install dependencies

```sh
npm install
```

### 2. Generate Spotify credentials

```sh
SPOTIFY_CLIENT_ID=your_client_id SPOTIFY_CLIENT_SECRET=your_client_secret npm run setup-token
```

This runs a local OAuth flow — opens a browser, you authorise, and it prints a refresh token. Create a `.env.local` with:

```
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REFRESH_TOKEN=...
SPOTIFY_USER_ID=...
```

### 3. Run

```sh
npm run dev
```

Open [localhost:3000](http://localhost:3000).

### Optional: Upstash Redis

Without Redis the app caches audio features in memory, which means progress is lost on server restart. For persistent caching, add:

```
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```

### Optional: basic auth gate

For production deployments, set `BASIC_AUTH_USER` and `BASIC_AUTH_PASS` to put the app behind HTTP basic auth.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
| `npm test` | Run tests once |
| `npm run test:watch` | Run tests in watch mode |
| `npm run setup-token` | OAuth flow to generate a Spotify refresh token |

## Tuning the classifier

Constants live in `src/lib/classifier.ts`:

- `GLOBAL_THRESHOLD` (default 0.75) — minimum similarity score for any proposal
- `GENRE_WEIGHT` (default 1.0) — how much genre features matter relative to audio features
- `MIN_PLAYLIST_SIZE` (default 10) — playlists smaller than this won't get a centroid

If too many songs end up in the "below threshold" tab, lower the threshold. If songs keep landing in the wrong playlists, try adjusting the genre weight.

## Safety

The app only adds tracks to playlists — it never deletes. Hydrate and classify are entirely read-only. Deduplication prevents adding songs that are already in a target playlist. If Redis is down or unconfigured, everything still works (just slower).
