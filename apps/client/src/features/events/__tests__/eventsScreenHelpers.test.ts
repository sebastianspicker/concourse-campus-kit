import { describe, expect, it } from "vitest";
import type { PublicEvent } from "@concourse/contracts";
import { getEventCard, getEventsEmptyHint, getEventsEmptyMessage, sortEventsByDate } from "../eventsScreenHelpers";

describe("getEventCard", () => {
  it("builds the board day cell, campus time, and source host", () => {
    const event: PublicEvent = {
      id: "welcome-concert",
      title: "Welcome concert",
      date: "2026-09-14T17:30:00+02:00",
      sourceUrl: "https://example.org/events/welcome-concert",
    };

    expect(getEventCard(event, "en", "Europe/Berlin")).toMatchObject({
      title: "Welcome concert",
      subtitle: "17:30 · example.org",
      subtitleIsData: true,
      day: { day: "14", weekday: "Mon" },
    });
    expect(getEventCard(event, "en", "Europe/Berlin", false).day).toBeNull();
  });
});

describe("event list helpers", () => {
  const mk = (id: string, date: string): PublicEvent => ({
    id,
    title: id,
    date,
    sourceUrl: "https://example.org/e",
  });

  it("sorts a copy by date in either direction", () => {
    const input = [mk("b", "2026-09-15T10:00:00Z"), mk("a", "2026-09-14T10:00:00Z"), mk("c", "2026-09-16T10:00:00Z")];
    expect(sortEventsByDate(input, "asc").map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(sortEventsByDate(input, "desc").map((e) => e.id)).toEqual(["c", "b", "a"]);
    expect(input.map((e) => e.id)).toEqual(["b", "a", "c"]);
  });

  it("selects search-specific or default empty copy", () => {
    const t = (key: string, values?: Record<string, string | number>) => `${key}:${values?.search ?? ""}`;
    expect(getEventsEmptyMessage("jazz", t)).toBe("noMatchingEvents:jazz");
    expect(getEventsEmptyMessage("", t)).toBe("noEvents:");
    expect(getEventsEmptyHint("jazz", t)).toBe("searchEmptyHint:");
    expect(getEventsEmptyHint("", t)).toBe("eventsEmptyHint:");
  });
});
