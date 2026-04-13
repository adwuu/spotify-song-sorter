/**
 * Animated spinning vinyl record with Spotify-green label.
 * Pure CSS animation — no external dependencies.
 */
export function VinylRecord() {
  return (
    <div className="relative">
      {/* Outer disc — spins continuously */}
      <div className="animate-[spin_4s_linear_infinite]">
        <svg width="140" height="140" viewBox="0 0 140 140" fill="none">
          {/* Vinyl body */}
          <circle cx="70" cy="70" r="68" fill="#1a1a1a" stroke="#333" strokeWidth="1" />

          {/* Grooves — concentric rings */}
          <circle cx="70" cy="70" r="60" fill="none" stroke="#222" strokeWidth="0.5" />
          <circle cx="70" cy="70" r="55" fill="none" stroke="#282828" strokeWidth="0.5" />
          <circle cx="70" cy="70" r="50" fill="none" stroke="#222" strokeWidth="0.5" />
          <circle cx="70" cy="70" r="45" fill="none" stroke="#282828" strokeWidth="0.5" />
          <circle cx="70" cy="70" r="40" fill="none" stroke="#222" strokeWidth="0.5" />
          <circle cx="70" cy="70" r="35" fill="none" stroke="#282828" strokeWidth="0.5" />

          {/* Light reflection arc */}
          <path
            d="M 30 40 A 50 50 0 0 1 80 25"
            fill="none"
            stroke="rgba(255,255,255,0.06)"
            strokeWidth="12"
            strokeLinecap="round"
          />

          {/* Center label */}
          <circle cx="70" cy="70" r="22" fill="#1DB954" />
          <circle cx="70" cy="70" r="20" fill="url(#labelGradient)" />

          {/* Spindle hole */}
          <circle cx="70" cy="70" r="3" fill="#1a1a1a" />

          <defs>
            <radialGradient id="labelGradient" cx="45%" cy="40%">
              <stop offset="0%" stopColor="#1ed760" />
              <stop offset="100%" stopColor="#1DB954" />
            </radialGradient>
          </defs>
        </svg>
      </div>

      {/* Floating music notes */}
      <div className="absolute -right-2 -top-2 animate-float text-2xl">
        ♪
      </div>
      <div className="absolute -left-1 top-4 animate-float-delayed text-lg text-spotify-green">
        ♫
      </div>
    </div>
  );
}
