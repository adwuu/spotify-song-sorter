/**
 * Next.js 16 proxy (formerly middleware).
 *
 * HTTP Basic Auth gate for the whole app. Single-user trust model —
 * compares against BASIC_AUTH_USER / BASIC_AUTH_PASS env vars. Browser
 * handles the credential prompt natively, so no custom login page.
 *
 * If the env vars are not set, the gate is disabled (useful for local dev).
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  const expectedUser = process.env.BASIC_AUTH_USER;
  const expectedPass = process.env.BASIC_AUTH_PASS;

  // No auth configured → open access (local dev).
  if (!expectedUser || !expectedPass) {
    return NextResponse.next();
  }

  const header = request.headers.get("authorization");
  if (header?.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      const [user, pass] = decoded.split(":");
      if (user === expectedUser && pass === expectedPass) {
        return NextResponse.next();
      }
    } catch {
      // fall through
    }
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="song-sorter", charset="UTF-8"',
    },
  });
}

export const proxyConfig = {
  matcher: [
    // Match everything except Next internals and public files.
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
