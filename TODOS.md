# TODOs

Deferred work from the v1 plan review. Each item has a clear trigger for picking it up.

---

## TODO-1: End-to-end integration test

**What:** Add one `tests/integration/sync.test.ts` that runs hydrate → classify → apply with mocked Spotify + mocked ReccoBeats + in-memory Upstash, asserting the full flow completes and writes match expectations.

**Why:** Unit tests cover individual modules but don't catch wiring bugs (wrong cache key schema, wrong SDK method name, wrong grouping in applyProposals). If we see a wiring-bug incident, write this test as part of the fix.

**Context:** Declined during plan review (option 10C) because v1 has no real users and unit coverage is solid. Trigger for writing this: first time a bug slips through unit tests and into manual smoke testing.

**Depends on / blocked by:** Nothing. Can be added any time.

---

## TODO-2: Scheduled automatic runs via Vercel cron

**What:** Add a Vercel cron job that hits the hydrate + classify pipeline on a schedule (daily), auto-applies only proposals above a higher confidence bar (e.g., 0.92), and notifies the owner on unusual outcomes.

**Why:** Current v1 requires manual button clicks. Set-and-forget mode means new liked songs get sorted automatically and you only glance at the app when you want to override something.

**Context:** The two-phase pipeline already makes this cheap to add — hydrate is already idempotent and resumable, so a cron calls it in a loop until done, then calls classify + a new `autoApply` flag on the apply action. Confidence threshold needs to be higher than manual mode since there's no human review.

**Depends on / blocked by:** v1 shipped and running manually for a few cycles so we have confidence in the classifier's accuracy at the higher threshold. Ideally ship TODO-4 (undo) first so auto-runs are reversible.

---

## TODO-3: Settings UI

**What:** Replace the hard-coded constants in `src/lib/classifier.ts` (`GLOBAL_THRESHOLD`, `GENRE_WEIGHT`, `MIN_PLAYLIST_SIZE`, `EXCLUDED_PLAYLIST_IDS`) with a settings page backed by Upstash. Threshold slider, playlist exclude list, genre weight slider.

**Why:** Current v1 requires a code edit + redeploy to tune parameters. A settings UI makes iteration feel instant.

**Context:** Settings would live under `/settings` as another single-page route. Store in Upstash under `settings:v1` as a JSON blob. Classifier reads it at run time with a sensible default fallback if missing. First tune likely to need: reducing threshold if too many songs end up unclassified; or excluding a specific "nostalgic" playlist that keeps attracting songs that don't belong.

**Depends on / blocked by:** Running v1 for a few cycles to understand which constants actually need tuning.

---

## TODO-4: Run history and undo

**What:** Log every `applyProposals` run to a persistent store (Neon Postgres via Vercel Marketplace): timestamp, songs added per playlist, confidence per song. Add an "Undo last run" button that removes exactly the additions from the most recent run.

**Why:** v1 is non-destructive but still takes manual effort to reverse if the classifier drifts. An undo button makes the trust barrier for enabling auto-apply (TODO-2) much lower.

**Context:** Needs a new dependency on Neon Postgres (Vercel Marketplace) and a simple schema: `runs` table with `{id, ran_at, outcomes jsonb}`. Undo is the trickiest part because it has to call `DELETE /playlists/{id}/tracks` — that's the first time the app would request removal capability, which requires re-running the OAuth setup with `playlist-modify-public` and `playlist-modify-private` scopes (these are already in the plan for writes, so no scope expansion — just an explicit DELETE path).

**Depends on / blocked by:** Likely should ship before TODO-2 (scheduled auto-runs) because auto-runs are much safer if undo exists.
