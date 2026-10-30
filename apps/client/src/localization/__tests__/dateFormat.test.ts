import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatBoardDateTime,
  formatBoardDay,
  formatBoardTime,
  formatBoardTimeRange,
  formatCampusId,
  formatEventDate,
  formatLongDate,
  formatRelativeTime,
  formatScheduleTime,
  formatSourceHost,
  formatTimeRange,
  getCampusDayKey,
  getFirstOfDayIds,
} from "../dateFormat";

const ISO = "2026-03-05T14:30:00Z";

describe("formatEventDate", () => {
  it("formats date and time in the requested locale and zone", () => {
    expect(formatEventDate(ISO, "en-US", "UTC")).toBe("3/5/2026, 2:30:00 PM");
    expect(formatEventDate(ISO, "de-DE", "UTC")).toBe("5.3.2026, 14:30:00");
    expect(formatEventDate(ISO, "en-US", "America/New_York")).toBe("3/5/2026, 9:30:00 AM");
    expect(formatEventDate(ISO, "de-DE", "Europe/Berlin")).toBe("5.3.2026, 15:30:00");
  });
});

describe("formatScheduleTime", () => {
  it("formats a two-digit time in the requested locale and zone", () => {
    expect(formatScheduleTime(ISO, "en-US", "UTC")).toBe("02:30 PM");
    expect(formatScheduleTime(ISO, "de-DE", "UTC")).toBe("14:30");
    expect(formatScheduleTime(ISO, "de-DE", "Europe/Berlin")).toBe("15:30");
  });
});

describe("formatTimeRange", () => {
  it("returns the start time alone without an end", () => {
    expect(formatTimeRange(ISO, undefined, "de-DE", "UTC")).toBe("14:30");
  });

  it("joins start and end with a hyphen", () => {
    expect(formatTimeRange(ISO, "2026-03-05T16:00:00Z", "de-DE", "UTC")).toBe("14:30 - 16:00");
    expect(formatTimeRange(ISO, "2026-03-05T16:00:00Z", "en-US", "UTC")).toBe("02:30 PM - 04:00 PM");
  });
});

describe("formatCampusId", () => {
  it("title-cases words separated by hyphens or underscores", () => {
    expect(formatCampusId("")).toBe("");
    expect(formatCampusId("main-campus_north")).toBe("Main Campus North");
    expect(formatCampusId("abc")).toBe("Abc");
  });
});

describe("formatRelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-05T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it("formats in English", () => {
    expect(formatRelativeTime(at(0), "en")).toBe("now");
    expect(formatRelativeTime(at(-30_000), "en")).toBe("now");
    expect(formatRelativeTime(at(-5 * MIN), "en")).toBe("5 minutes ago");
    expect(formatRelativeTime(at(3 * HOUR), "en")).toBe("in 3 hours");
    expect(formatRelativeTime(at(-DAY), "en")).toBe("yesterday");
    expect(formatRelativeTime(at(2 * DAY), "en")).toBe("in 2 days");
    expect(formatRelativeTime(at(-14 * DAY), "en")).toBe("2 weeks ago");
    expect(formatRelativeTime(at(-60 * DAY), "en")).toBe("2 months ago");
    expect(formatRelativeTime(at(-800 * DAY), "en")).toBe("2 years ago");
  });

  it("formats in German", () => {
    expect(formatRelativeTime(at(0), "de")).toBe("jetzt");
    expect(formatRelativeTime(at(-5 * MIN), "de")).toBe("vor 5 Minuten");
    expect(formatRelativeTime(at(3 * HOUR), "de")).toBe("in 3 Stunden");
    expect(formatRelativeTime(at(-DAY), "de")).toBe("gestern");
  });

  it("uses day units up to the week threshold", () => {
    expect(formatRelativeTime(at(-20 * MIN), "en")).toBe("20 minutes ago");
    expect(formatRelativeTime(at(-(6 * DAY + 20 * HOUR)), "en")).toBe("7 days ago");
  });
});

describe("board formatters", () => {
  const evening = "2026-09-16T17:30:00Z";

  it("uses 24-hour campus time in both languages", () => {
    expect(formatBoardTime(evening, "en", "Europe/Berlin")).toBe("19:30");
    expect(formatBoardTime(evening, "de", "Europe/Berlin")).toBe("19:30");
    expect(formatBoardTimeRange(evening, "2026-09-16T19:00:00Z", "en", "Europe/Berlin")).toBe("19:30 - 21:00");
    expect(formatBoardTimeRange(evening, undefined, "en", "Europe/Berlin")).toBe("19:30");
  });

  it("splits a board day cell and builds compact and long dates", () => {
    expect(formatBoardDay(evening, "en", "Europe/Berlin")).toMatchObject({ weekday: "Wed", day: "16" });
    expect(formatBoardDay(evening, "en", "Europe/Berlin").month).toMatch(/^Sept?$/);
    expect(formatBoardDay(evening, "de", "Europe/Berlin").day).toBe("16");
    expect(formatBoardDateTime(evening, "en", "Europe/Berlin")).toMatch(/^Wed 16 Sept? · 19:30$/);
    expect(formatLongDate(evening, "en", "Europe/Berlin")).toBe("Wednesday, 16 September 2026");
    expect(formatLongDate(evening, "de", "Europe/Berlin")).toBe("Mittwoch, 16. September 2026");
  });

  it("keys rows by campus day, not UTC day", () => {
    expect(getCampusDayKey("2026-09-16T22:30:00Z", "Europe/Berlin")).toBe("2026-09-17");
    expect(getCampusDayKey("2026-09-16T22:30:00Z", "UTC")).toBe("2026-09-16");
  });

  it("reduces a source URL to its public host", () => {
    expect(formatSourceHost("https://www.example.org/events/a")).toBe("example.org");
    expect(formatSourceHost("not a url")).toBe("");
  });
});

describe("getFirstOfDayIds", () => {
  it("marks only the first row of each consecutive campus day", () => {
    const rows = [
      { id: "a", at: "2026-09-16T08:00:00Z" },
      { id: "b", at: "2026-09-16T20:00:00Z" },
      { id: "c", at: "2026-09-16T22:30:00Z" },
      { id: "d", at: "2026-09-18T09:00:00Z" },
    ];
    const firsts = getFirstOfDayIds(rows, (row) => row.id, (row) => row.at, "Europe/Berlin");
    expect([...firsts]).toEqual(["a", "c", "d"]);
  });
});
