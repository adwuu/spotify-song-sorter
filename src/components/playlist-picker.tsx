"use client";

import { useState } from "react";
import type { PlaylistInfo, SyncConfig } from "@/app/actions/sync";

/**
 * Two-panel playlist picker. User selects:
 *   - Source: which playlists to sort FROM (+ optional Liked Songs toggle)
 *   - Targets: which playlists to sort INTO
 *
 * Playlists show name, track count, and cover art.
 */
export function PlaylistPicker({
  playlists,
  onStart,
}: {
  playlists: PlaylistInfo[];
  onStart: (config: SyncConfig) => void;
}) {
  const [includeLiked, setIncludeLiked] = useState(true);
  const [sources, setSources] = useState<Set<string>>(new Set());
  const [targets, setTargets] = useState<Set<string>>(
    () => new Set(playlists.filter((p) => p.trackCount >= 10).map((p) => p.id)),
  );

  function toggleSource(id: string) {
    setSources((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleTarget(id: string) {
    setTargets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const hasSource = includeLiked || sources.size > 0;
  const hasTarget = targets.size > 0;

  return (
    <div>
      <p className="mb-8 text-center text-spotify-subtext">
        Choose which playlists to sort from and into, then start sorting.
      </p>

      <div className="grid gap-8 md:grid-cols-2">
        {/* ─── Sort FROM ─── */}
        <div>
          <h2 className="mb-4 text-lg font-semibold">Sort from</h2>

          {/* Liked Songs toggle */}
          <label className="mb-2 flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 hover:bg-white/10">
            <input
              type="checkbox"
              checked={includeLiked}
              onChange={() => setIncludeLiked(!includeLiked)}
              className="h-4 w-4 accent-spotify-green"
            />
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm bg-gradient-to-br from-indigo-600 to-purple-500">
              <svg className="h-5 w-5 text-white" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-spotify-text">
                Liked Songs
              </p>
              <p className="text-xs text-spotify-subtext">
                Your saved tracks
              </p>
            </div>
          </label>

          {/* Source playlists */}
          {playlists.map((p) => (
            <PlaylistRow
              key={p.id}
              playlist={p}
              checked={sources.has(p.id)}
              onToggle={() => toggleSource(p.id)}
            />
          ))}
        </div>

        {/* ─── Sort INTO ─── */}
        <div>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Sort into</h2>
            <button
              onClick={() => {
                if (targets.size === playlists.length) {
                  setTargets(new Set());
                } else {
                  setTargets(new Set(playlists.map((p) => p.id)));
                }
              }}
              className="text-xs text-spotify-subtext hover:text-spotify-text"
            >
              {targets.size === playlists.length ? "Deselect all" : "Select all"}
            </button>
          </div>

          {playlists.map((p) => (
            <PlaylistRow
              key={p.id}
              playlist={p}
              checked={targets.has(p.id)}
              onToggle={() => toggleTarget(p.id)}
            />
          ))}
        </div>
      </div>

      {/* Start button */}
      <div className="mt-8 text-center">
        <button
          onClick={() =>
            onStart({
              includeLikedSongs: includeLiked,
              sourcePlaylistIds: Array.from(sources),
              targetPlaylistIds: Array.from(targets),
            })
          }
          disabled={!hasSource || !hasTarget}
          className="rounded-full bg-spotify-green px-10 py-3 text-sm font-bold text-black transition-all hover:scale-105 hover:bg-spotify-green-hover active:scale-100 disabled:scale-100 disabled:bg-white/10 disabled:text-spotify-subtext"
        >
          Start sorting
        </button>
        {!hasSource && (
          <p className="mt-2 text-xs text-red-400">
            Select at least one source to sort from
          </p>
        )}
        {hasSource && !hasTarget && (
          <p className="mt-2 text-xs text-red-400">
            Select at least one target playlist to sort into
          </p>
        )}
      </div>
    </div>
  );
}

function PlaylistRow({
  playlist,
  checked,
  onToggle,
}: {
  playlist: PlaylistInfo;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="mb-1 flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 hover:bg-white/10">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="h-4 w-4 accent-spotify-green"
      />
      {playlist.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={playlist.imageUrl}
          alt=""
          className="h-10 w-10 rounded-sm"
          loading="lazy"
        />
      ) : (
        <div className="h-10 w-10 rounded-sm bg-spotify-highlight" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-spotify-text">
          {playlist.name}
        </p>
        {playlist.trackCount > 0 && (
          <p className="text-xs text-spotify-subtext">
            {playlist.trackCount} tracks
          </p>
        )}
      </div>
    </label>
  );
}
