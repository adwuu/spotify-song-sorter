"use client";

import { useState, useEffect } from "react";
import Lottie from "lottie-react";
import {
  hydrateAction,
  classifyAction,
  applyAction,
  fetchPlaylistsAction,
  type PlaylistInfo,
  type SyncConfig,
} from "@/app/actions/sync";
import { PlaylistPicker } from "@/components/playlist-picker";
import type {
  Proposal,
  ClassifyResult,
  SkippedSong,
} from "@/lib/classifier";

type OkResult = Extract<ClassifyResult, { ok: true }>;

type UIState =
  | { kind: "idle" }
  | { kind: "picking"; playlists: PlaylistInfo[] }
  | { kind: "loading"; phase: string; detail?: string }
  | { kind: "ready"; result: OkResult }
  | { kind: "done"; added: number; playlists: number }
  | { kind: "error"; message: string };

export function ProposalTable() {
  const [ui, setUi] = useState<UIState>({ kind: "idle" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<
    "to_sort" | "already_placed" | "no_features" | "below_threshold"
  >("to_sort");
  const [lastConfig, setLastConfig] = useState<SyncConfig | null>(null);
  const [search, setSearch] = useState("");

  async function handleSync() {
    try {
      setUi({ kind: "loading", phase: "Fetching your playlists..." });
      const playlists = await fetchPlaylistsAction();
      setUi({ kind: "picking", playlists });
    } catch (err) {
      setUi({ kind: "error", message: (err as Error).message });
    }
  }

  async function handleStartSort(config: SyncConfig) {
    try {
      setLastConfig(config);
      setUi({ kind: "loading", phase: "Connecting to Spotify..." });

      for (let pass = 0; pass < 50; pass++) {
        setUi({
          kind: "loading",
          phase: "Fetching audio features from ReccoBeats...",
          detail: pass === 0 ? "Starting..." : undefined,
        });
        const result = await hydrateAction(config);
        const { hydrated, total } = result.progress;
        const pct = total > 0 ? Math.round((hydrated / total) * 100) : 0;

        if (result.done) {
          setUi({
            kind: "loading",
            phase: "Fetching audio features from ReccoBeats...",
            detail: `${hydrated.toLocaleString()} of ${total.toLocaleString()} tracks (${pct}%) — done`,
          });
          break;
        }

        if (result.cooldownSeconds) {
          // Show a countdown while waiting for the rate limit to expire.
          const waitUntil = Date.now() + result.cooldownSeconds * 1000;
          while (Date.now() < waitUntil) {
            const secsLeft = Math.ceil((waitUntil - Date.now()) / 1000);
            setUi({
              kind: "loading",
              phase: "Fetching audio features from ReccoBeats...",
              detail: `${hydrated.toLocaleString()} of ${total.toLocaleString()} tracks (${pct}%) — rate limit cooldown ${secsLeft}s`,
            });
            await new Promise((r) => setTimeout(r, 1000));
          }
        } else {
          setUi({
            kind: "loading",
            phase: "Fetching audio features from ReccoBeats...",
            detail: `${hydrated.toLocaleString()} of ${total.toLocaleString()} tracks (${pct}%)`,
          });
        }
      }

      setUi({
        kind: "loading",
        phase: "Classifying your songs...",
        detail: "Matching source songs to target playlists",
      });
      const classifyResult = await classifyAction();

      if (!classifyResult.ok) {
        setUi({ kind: "error", message: classifyResult.message });
        return;
      }

      setSelected(new Set(classifyResult.proposals.map((p) => p.trackId)));
      setFilter("to_sort");
      setUi({ kind: "ready", result: classifyResult });
    } catch (err) {
      setUi({ kind: "error", message: (err as Error).message });
    }
  }

  async function handleApply() {
    if (ui.kind !== "ready") return;
    const approved = ui.result.proposals.filter((p) =>
      selected.has(p.trackId),
    );
    if (approved.length === 0) return;

    setUi({
      kind: "loading",
      phase: "Adding songs to your playlists...",
      detail: `${approved.length} songs`,
    });
    try {
      const result = await applyAction(approved);
      setUi({
        kind: "done",
        added: result.totalAdded,
        playlists: result.results.filter((r) => r.added > 0).length,
      });
    } catch (err) {
      setUi({ kind: "error", message: (err as Error).message });
    }
  }

  function toggle(trackId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      return next;
    });
  }

  // ─── idle ───
  if (ui.kind === "idle") {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <p className="mb-8 text-lg text-spotify-subtext">
          Click to scan your library and see what can be sorted.
        </p>
        <GreenButton onClick={handleSync}>Sync &amp; preview</GreenButton>
      </div>
    );
  }

  // ─── playlist picker ───
  if (ui.kind === "picking") {
    return (
      <PlaylistPicker
        playlists={ui.playlists}
        onStart={handleStartSort}
      />
    );
  }

  // ─── loading ───
  if (ui.kind === "loading") {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Spinner />
        <p className="mt-8 text-lg font-semibold text-spotify-text">
          {ui.phase}
        </p>
        {ui.detail && (
          <p className="mt-2 text-sm text-spotify-subtext">{ui.detail}</p>
        )}
        <IndeterminateBar />
      </div>
    );
  }

  // ─── done ───
  if (ui.kind === "done") {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-spotify-green">
          <svg className="h-8 w-8 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <p className="mb-2 text-2xl font-bold">
          Added {ui.added} songs
        </p>
        <p className="mb-8 text-spotify-subtext">
          across {ui.playlists} playlist{ui.playlists === 1 ? "" : "s"}
        </p>
        <GreenButton onClick={handleSync}>Sync again</GreenButton>
      </div>
    );
  }

  // ─── error ───
  if (ui.kind === "error") {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <p className="mb-2 text-lg font-semibold text-red-400">
          Something went wrong
        </p>
        <p className="mb-8 max-w-md text-sm text-spotify-subtext">
          {ui.message}
        </p>
        <OutlineButton onClick={handleSync}>Try again</OutlineButton>
      </div>
    );
  }

  // ─── ready ───
  const { result } = ui;
  const { proposals, skipped, stats } = result;
  const selectedCount = proposals.filter((p) =>
    selected.has(p.trackId),
  ).length;

  const q = search.toLowerCase().trim();
  const matchesSearch = (name: string, artists: string[]) =>
    !q ||
    name.toLowerCase().includes(q) ||
    artists.some((a) => a.toLowerCase().includes(q));

  const alreadyPlacedSongs = skipped.filter(
    (s) => s.reason === "already_placed" && matchesSearch(s.trackName, s.artistNames),
  );
  const noFeaturesSongs = skipped.filter(
    (s) => s.reason === "no_features" && matchesSearch(s.trackName, s.artistNames),
  );
  const belowThresholdSongs = skipped.filter(
    (s) => s.reason === "below_threshold" && matchesSearch(s.trackName, s.artistNames),
  );
  const filteredProposals = proposals.filter((p) =>
    matchesSearch(p.trackName, p.artistNames),
  );

  return (
    <div>
      {/* Search + filter pills */}
      <div className="mb-4">
        <div className="relative">
          <svg
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-spotify-subtext"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z"
            />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by song or artist..."
            className="w-full rounded-md bg-white/10 py-2.5 pl-10 pr-4 text-sm text-spotify-text placeholder-spotify-subtext outline-none transition-colors focus:bg-white/15 focus:ring-1 focus:ring-white/20"
          />
        </div>
      </div>
      <div className="mb-6 flex flex-wrap gap-2">
        <Pill
          label="To sort"
          count={stats.proposed}
          active={filter === "to_sort"}
          onClick={() => setFilter("to_sort")}
        />
        <Pill
          label="Already placed"
          count={stats.alreadyPlaced}
          active={filter === "already_placed"}
          onClick={() => setFilter("already_placed")}
        />
        <Pill
          label="No features"
          count={stats.unclassifiable}
          active={filter === "no_features"}
          onClick={() => setFilter("no_features")}
        />
        <Pill
          label="Below threshold"
          count={stats.belowThreshold}
          active={filter === "below_threshold"}
          onClick={() => setFilter("below_threshold")}
        />
      </div>

      {/* ─── To sort tab ─── */}
      {filter === "to_sort" && (
        filteredProposals.length > 0 ? (
          <>
            <div className="mb-1 grid grid-cols-[2rem_3rem_1fr_auto_4rem_2rem] items-center gap-4 border-b border-white/10 px-4 py-2 text-xs uppercase tracking-wider text-spotify-subtext">
              <span>#</span>
              <span />
              <span>Title</span>
              <span>Playlist</span>
              <span className="text-right">Match</span>
              <span />
            </div>
            <div>
              {filteredProposals.map((p, i) => (
                <ProposalRow
                  key={p.trackId}
                  index={i + 1}
                  proposal={p}
                  checked={selected.has(p.trackId)}
                  onToggle={() => toggle(p.trackId)}
                />
              ))}
            </div>
          </>
        ) : (
          <EmptyTab message={q ? "No matching songs to sort." : "No songs to sort right now."} />
        )
      )}

      {/* ─── Already placed tab ─── */}
      {filter === "already_placed" && (
        alreadyPlacedSongs.length > 0 ? (
          <SkippedList songs={alreadyPlacedSongs} />
        ) : (
          <EmptyTab message={q ? "No matches found." : "No liked songs are in your playlists yet."} />
        )
      )}

      {/* ─── No features tab ─── */}
      {filter === "no_features" && (
        noFeaturesSongs.length > 0 ? (
          <SkippedList songs={noFeaturesSongs} />
        ) : (
          <EmptyTab message={q ? "No matches found." : "All songs have audio features."} />
        )
      )}

      {/* ─── Below threshold tab ─── */}
      {filter === "below_threshold" && (
        belowThresholdSongs.length > 0 ? (
          <SkippedList songs={belowThresholdSongs} />
        ) : (
          <EmptyTab message={q ? "No matches found." : "No songs fell below the similarity threshold."} />
        )
      )}

      {/* Sticky footer — only on To sort tab with proposals */}
      {filter === "to_sort" && proposals.length > 0 && (
        <div className="sticky bottom-0 -mx-8 mt-8 border-t border-white/10 bg-gradient-to-t from-black via-black/95 to-black/80 px-8 py-5 backdrop-blur-sm">
          <div className="mx-auto flex max-w-5xl items-center justify-between">
            <p className="text-sm text-spotify-subtext">
              {selectedCount} of {proposals.length} songs selected
            </p>
            <GreenButton onClick={handleApply} disabled={selectedCount === 0}>
              Apply to Spotify
            </GreenButton>
          </div>
        </div>
      )}

      {/* Sync again when no proposals */}
      {filter === "to_sort" && proposals.length === 0 && (
        <div className="mt-8 text-center">
          <OutlineButton onClick={handleSync}>Sync again</OutlineButton>
        </div>
      )}
    </div>
  );
}

// ─── pill (Spotify genre-style filter chip) ───

function Pill({
  label,
  count,
  active = false,
  onClick,
}: {
  label: string;
  count: number;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
        active
          ? "bg-spotify-green text-black"
          : "bg-white/10 text-spotify-text hover:bg-white/20"
      }`}
    >
      {label}
      <span className={active ? "text-black/70" : "text-spotify-subtext"}>
        {count}
      </span>
    </button>
  );
}

function EmptyTab({ message }: { message: string }) {
  return (
    <div className="rounded-lg bg-spotify-elevated/50 p-12 text-center">
      <p className="text-spotify-subtext">{message}</p>
    </div>
  );
}

// ─── proposal row (Spotify track-list style) ───

function ProposalRow({
  index,
  proposal,
  checked,
  onToggle,
}: {
  index: number;
  proposal: Proposal;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      htmlFor={`cb-${proposal.trackId}`}
      className="group grid cursor-pointer grid-cols-[2rem_3rem_1fr_auto_4rem_2rem] items-center gap-4 rounded-sm px-4 py-2 hover:bg-white/10"
    >
      {/* Row number */}
      <span className="text-right text-sm tabular-nums text-spotify-subtext group-hover:text-spotify-text">
        {index}
      </span>

      {/* Album art */}
      {proposal.albumArtUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={proposal.albumArtUrl}
          alt=""
          className="h-10 w-10 rounded-[2px]"
          loading="lazy"
        />
      ) : (
        <div className="h-10 w-10 rounded-[2px] bg-spotify-highlight" />
      )}

      {/* Title + artist */}
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-spotify-text group-hover:text-white">
          {proposal.trackName}
        </p>
        <p className="truncate text-[13px] text-spotify-subtext">
          {proposal.artistNames.join(", ")}
        </p>
      </div>

      {/* Target playlist */}
      <span className="rounded-full bg-white/5 px-3 py-1 text-xs text-spotify-subtext group-hover:bg-white/10 group-hover:text-spotify-text">
        {proposal.playlistName}
      </span>

      {/* Similarity */}
      <span className="text-right text-sm tabular-nums text-spotify-subtext">
        {(proposal.similarity * 100).toFixed(0)}%
      </span>

      {/* Checkbox */}
      <input
        id={`cb-${proposal.trackId}`}
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="h-4 w-4 accent-spotify-green"
      />
    </label>
  );
}

// ─── skipped songs list ───

function SkippedList({ songs }: { songs: SkippedSong[] }) {
  return (
    <div className="space-y-0">
      {songs.map((s) => (
        <div
          key={s.trackId}
          className="flex items-center gap-4 rounded-sm px-4 py-2 hover:bg-white/5"
        >
          {s.albumArtUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={s.albumArtUrl}
              alt=""
              className="h-10 w-10 rounded-[2px]"
              loading="lazy"
            />
          ) : (
            <div className="h-10 w-10 rounded-[2px] bg-spotify-highlight" />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-spotify-text">
              {s.trackName}
            </p>
            <p className="truncate text-[13px] text-spotify-subtext">
              {s.artistNames.join(", ")}
            </p>
          </div>
          <p className="shrink-0 text-xs text-spotify-subtext">{s.detail}</p>
        </div>
      ))}
    </div>
  );
}

// ─── buttons ───

function GreenButton({
  onClick,
  disabled = false,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-full bg-spotify-green px-8 py-3 text-sm font-bold text-black transition-all hover:scale-105 hover:bg-spotify-green-hover active:scale-100 disabled:scale-100 disabled:bg-white/10 disabled:text-spotify-subtext"
    >
      {children}
    </button>
  );
}

function OutlineButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded-full border border-white/30 px-6 py-2 text-sm font-semibold text-spotify-text transition-all hover:scale-105 hover:border-white active:scale-100"
    >
      {children}
    </button>
  );
}

// ─── loading components ───

function Spinner() {
  const [animData, setAnimData] = useState<Record<string, unknown> | null>(
    null,
  );
  useEffect(() => {
    fetch("/animations/monkey.json")
      .then((r) => r.json())
      .then(setAnimData)
      .catch(() => {}); // Falls back to CSS spinner below
  }, []);

  if (animData) {
    return (
      <div className="h-24 w-24">
        <Lottie animationData={animData} loop />
      </div>
    );
  }
  // Fallback CSS spinner while Lottie loads
  return (
    <div className="h-12 w-12 animate-spin rounded-full border-[3px] border-white/10 border-t-spotify-green" />
  );
}

function IndeterminateBar() {
  return (
    <div className="relative mx-auto mt-8 h-1 w-72 overflow-hidden rounded-full bg-white/10">
      <div className="absolute h-full w-1/3 animate-[indeterminate_1.5s_ease-in-out_infinite] rounded-full bg-spotify-green" />
      <style jsx>{`
        @keyframes indeterminate {
          0% {
            left: -33%;
          }
          100% {
            left: 100%;
          }
        }
      `}</style>
    </div>
  );
}
