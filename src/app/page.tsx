import { ProposalTable } from "@/components/proposal-table";
import { VinylRecord } from "@/components/vinyl-record";

export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-spotify-purple/40 via-black/80 to-black">
      {/* Hero header — mimics Spotify's playlist header gradient */}
      <header className="px-8 pb-6 pt-16">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-end gap-6">
            {/* Animated vinyl record */}
            <div className="flex h-[230px] w-[230px] shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-indigo-700 via-purple-600 to-fuchsia-500 shadow-2xl shadow-purple-900/40">
              <VinylRecord />
            </div>
            {/* Title */}
            <div className="min-w-0">
              <p className="text-sm font-medium">Playlist sorter</p>
              <h1 className="mt-2 text-[5rem] font-extrabold leading-none tracking-tight">
                Spotify Sorter
              </h1>
              <p className="mt-4 text-sm text-spotify-subtext">
                Auto-sort your songs into your custom playlists using audio features
              </p>
            </div>
          </div>
        </div>
      </header>

      {/* Content area */}
      <main className="mx-auto max-w-5xl px-8 pb-32">
        <ProposalTable />
      </main>
    </div>
  );
}
