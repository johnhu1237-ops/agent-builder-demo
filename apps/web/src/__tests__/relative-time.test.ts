import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "../relative-time";

const now = new Date("2026-06-25T12:00:00.000Z").getTime();
const ago = (ms: number) => new Date(now - ms).toISOString();

describe("formatRelativeTime", () => {
  it("returns 'just now' under a minute", () => {
    expect(formatRelativeTime(ago(30_000), now)).toBe("just now");
  });

  it("formats whole minutes", () => {
    expect(formatRelativeTime(ago(60_000), now)).toBe("1m ago");
    expect(formatRelativeTime(ago(5 * 60_000), now)).toBe("5m ago");
  });

  it("formats whole hours", () => {
    expect(formatRelativeTime(ago(3 * 3_600_000), now)).toBe("3h ago");
  });

  it("formats whole days", () => {
    expect(formatRelativeTime(ago(2 * 86_400_000), now)).toBe("2d ago");
  });

  it("clamps future timestamps to 'just now'", () => {
    expect(formatRelativeTime(ago(-10_000), now)).toBe("just now");
  });
});
