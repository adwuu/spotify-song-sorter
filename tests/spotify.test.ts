import { describe, it, expect } from "vitest";
import { isRealTrack } from "@/lib/spotify";

describe("isRealTrack ingestion filter", () => {
  it("accepts a normal Track", () => {
    expect(
      isRealTrack({
        id: "abc123",
        type: "track",
        is_local: false,
        name: "Song",
      }),
    ).toBe(true);
  });

  it("rejects episode items (podcasts)", () => {
    expect(
      isRealTrack({
        id: "ep123",
        type: "episode",
        is_local: false,
        name: "Podcast",
      }),
    ).toBe(false);
  });

  it("rejects local files", () => {
    expect(
      isRealTrack({
        id: "local1",
        type: "track",
        is_local: true,
        name: "Local Song",
      }),
    ).toBe(false);
  });

  it("rejects null", () => {
    expect(isRealTrack(null)).toBe(false);
  });

  it("rejects objects without an id", () => {
    expect(isRealTrack({ type: "track", is_local: false })).toBe(false);
  });

  it("rejects non-object values", () => {
    expect(isRealTrack("not a track")).toBe(false);
    expect(isRealTrack(42)).toBe(false);
  });
});
