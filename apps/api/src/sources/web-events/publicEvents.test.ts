/** Verifies the public web-event adapter never emits or logs unsafe source URLs. */

import type { InstitutionPack } from "@concourse/institutions";
import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchTextWithTimeout, log } = vi.hoisted(() => ({
  fetchTextWithTimeout: vi.fn(),
  log: vi.fn()
}));

vi.mock("../upstream/httpClient", () => ({ fetchTextWithTimeout }));
vi.mock("../../runtime/logger", () => ({ log }));

import { clearCache } from "../upstream/cache";
import { fetchPublicEvents } from "./publicEvents";

afterEach(() => {
  clearCache();
  vi.clearAllMocks();
});

const OPTIONS = { cacheTtlMs: 300_000, mode: "auto" };

function institution(id: string, url: string, ...moreUrls: string[]): InstitutionPack {
  return {
    id,
    name: "Example University",
    type: "university",
    timezone: "Europe/Berlin",
    campuses: [],
    publicSources: { events: [url, ...moreUrls].map((sourceUrl, index) => ({ label: index === 0 ? "Campus calendar" : `Calendar ${index + 1}`, url: sourceUrl })) }
  };
}

function articles(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `
    <article><h3><a href="/events/${prefix}-${index}">${prefix} event ${index}</a></h3>
      <time datetime="2026-11-${String(index + 1).padStart(2, "0")}T18:00:00+01:00">${index + 1} November</time>
    </article>`).join("");
}

describe("fetchPublicEvents", () => {
  it("drops an unsafe source that bypassed pack validation without fetching or exposing it", async () => {
    const result = await fetchPublicEvents(institution("unsafe-source", "https://reader:secret@example.org/events"), OPTIONS);

    expect(result).toEqual({ events: [], degraded: true });
    expect(fetchTextWithTimeout).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("drops unsafe event links found in otherwise public source HTML", async () => {
    fetchTextWithTimeout.mockResolvedValueOnce(`
      <a href="https://127.0.0.1/admin">Private event 04.11.2026</a>
      <a href="https://events.example.org/recital">Campus recital 04.11.2026</a>
    `);

    const result = await fetchPublicEvents(institution("unsafe-link", "https://www.example.org/events"), OPTIONS);

    expect(result.degraded).toBe(false);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.sourceUrl).toBe("https://events.example.org/recital");
  });

  it("logs a stable source label instead of a failing source URL or error message", async () => {
    fetchTextWithTimeout.mockRejectedValueOnce(new Error("request failed for https://reader:secret@example.org/events"));

    const result = await fetchPublicEvents(institution("safe-log", "https://www.example.org/events"), OPTIONS);

    expect(result).toEqual({
      events: [{
        id: expect.any(String),
        title: "Campus calendar",
        date: expect.any(String),
        sourceUrl: "https://www.example.org/events"
      }],
      degraded: true
    });
    expect(log).toHaveBeenCalledWith("warn", "public_events_source_failed", {
      source: "Campus calendar",
      reason: "upstream_request_failed"
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("reader:secret");
  });

  it("bounds malformed HTML scanning and keeps the source-label fallback", async () => {
    fetchTextWithTimeout.mockResolvedValueOnce([
      "<article>".repeat(4_000),
      '<div class="event">'.repeat(4_000),
      '<a href="/event">'.repeat(4_000),
    ].join(""));

    const result = await fetchPublicEvents(institution("malformed-html", "https://www.hfmt-koeln.de/veranstaltungen"), OPTIONS);

    expect(result).toEqual({
      events: [{
        id: expect.any(String),
        title: "Campus calendar",
        date: expect.any(String),
        sourceUrl: "https://www.hfmt-koeln.de/veranstaltungen"
      }],
      degraded: true
    });
  });

  it("keeps ordinary HfMT article extraction", async () => {
    fetchTextWithTimeout.mockResolvedValueOnce(`
      <article data-event-title="Public recital" data-event-url="/veranstaltungen/recital">
        <time datetime="2026-11-04T19:30:00+01:00"></time>
      </article>
    `);

    const result = await fetchPublicEvents(institution("hfmt-article", "https://www.hfmt-koeln.de/veranstaltungen"), OPTIONS);

    expect(result).toMatchObject({
      degraded: false,
      events: [{ title: "Public recital", sourceUrl: "https://www.hfmt-koeln.de/veranstaltungen/recital" }]
    });
  });

  it("preserves offsets around Unicode text and quoted greater-than characters", async () => {
    fetchTextWithTimeout.mockResolvedValueOnce(`
      ${"İ".repeat(10)}
      <article data-event-title="İstanbul recital > Encore" data-event-url="/veranstaltungen/encore">
        <time datetime="2026-11-04T19:30:00+01:00"></time>
      </article>
    `);

    const result = await fetchPublicEvents(institution("hfmt-unicode", "https://www.hfmt-koeln.de/veranstaltungen"), OPTIONS);

    expect(result).toMatchObject({
      degraded: false,
      events: [{
        title: "İstanbul recital > Encore",
        sourceUrl: "https://www.hfmt-koeln.de/veranstaltungen/encore"
      }]
    });
  });

  it("parses article dates for institutions other than HfMT", async () => {
    fetchTextWithTimeout.mockResolvedValueOnce(`
      <nav><a href="/about">About the university</a></nav>
      <article>
        <h3><a href="/events/open-house">Open house</a></h3>
        <time datetime="2026-11-04T10:00:00+01:00">4 November 2026, 10:00</time>
      </article>
    `);

    const result = await fetchPublicEvents(institution("generic-article", "https://www.example.org/events"), OPTIONS);

    expect(result).toEqual({
      degraded: false,
      events: [{
        id: expect.any(String),
        title: "Open house",
        date: "2026-11-04T09:00:00.000Z",
        sourceUrl: "https://www.example.org/events/open-house"
      }]
    });
  });

  it("parses German page dates in event tiles in the institution time zone", async () => {
    fetchTextWithTimeout.mockResolvedValueOnce(`
      <div class="event-tile">
        <h2>Semester concert</h2>
        <span>12.11.2026 19:30</span>
        <a href="/events/semester-concert">Details</a>
      </div>
    `);

    const result = await fetchPublicEvents(institution("generic-tile", "https://www.example.org/events"), OPTIONS);

    expect(result.events).toEqual([expect.objectContaining({
      title: "Semester concert",
      date: "2026-11-12T18:30:00.000Z",
      sourceUrl: "https://www.example.org/events/semester-concert"
    })]);
  });

  it("never emits placeholder 1970 dates for links without a date", async () => {
    fetchTextWithTimeout.mockResolvedValueOnce(`
      <a href="/about">About the university</a>
      <a href="/contact">Contact and directions</a>
    `);

    const result = await fetchPublicEvents(institution("generic-undated", "https://www.example.org/events"), OPTIONS);

    expect(result.degraded).toBe(true);
    expect(result.events).toEqual([expect.objectContaining({ title: "Campus calendar", sourceUrl: "https://www.example.org/events" })]);
    expect(result.events.some((event) => event.date.startsWith("1970"))).toBe(false);
  });

  it("returns every parsed event across sources instead of capping the merged list", async () => {
    fetchTextWithTimeout
      .mockResolvedValueOnce(articles("first", 6))
      .mockResolvedValueOnce(articles("second", 6));

    const result = await fetchPublicEvents(
      institution("two-sources", "https://www.example.org/events", "https://music.example.org/events"),
      OPTIONS
    );

    expect(result.degraded).toBe(false);
    expect(result.events).toHaveLength(12);
  });

  it("skips an entry with an impossible calendar date and keeps the rest of the page", async () => {
    fetchTextWithTimeout.mockResolvedValueOnce(`
      <article><h3><a href="/events/broken">Broken date</a></h3><span>31.02.2026</span></article>
      <article><h3><a href="/events/valid">Valid date</a></h3><span>12.11.2026 19:30</span></article>
    `);

    const result = await fetchPublicEvents(institution("generic-invalid-date", "https://www.example.org/events"), OPTIONS);

    expect(result.degraded).toBe(false);
    expect(result.events).toEqual([expect.objectContaining({ title: "Valid date", date: "2026-11-12T18:30:00.000Z" })]);
    expect(log).not.toHaveBeenCalled();
  });

  it("reads an offset-less datetime in the pack zone and decodes entities (T-8)", async () => {
    fetchTextWithTimeout.mockResolvedValueOnce(`
      <article><h3>Konzert &amp; Lesung</h3><a href="/e?id=7&amp;lang=de">Mehr</a>
        <time datetime="2026-11-05T19:30">5. November</time></article>`);

    const result = await fetchPublicEvents(institution("entities-zone", "https://www.example.org/events"), OPTIONS);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.title).toBe("Konzert & Lesung");
    expect(result.events[0]?.sourceUrl.endsWith("/e?id=7&lang=de")).toBe(true);
    expect(result.events[0]?.date).toBe("2026-11-05T18:30:00.000Z");
  });

  it("handles date-only values and named and numeric references (T-9)", async () => {
    fetchTextWithTimeout.mockResolvedValueOnce(`
      <article><h3>Gro&szlig;er Saal</h3><a href="/a">x</a><time datetime="2026-11-05">5. November</time></article>
      <article><h3>A &#8211; B &#x2013; C &bogus; &#0;</h3><a href="/b">x</a><time datetime="2026-11-06T10:00:00+01:00">6. November</time></article>`);

    const result = await fetchPublicEvents(institution("entities-date", "https://www.example.org/events"), OPTIONS);

    expect(result.events.map((event) => [event.title, event.date])).toEqual([
      ["Großer Saal", "2026-11-04T23:00:00.000Z"],
      ["A – B – C &bogus; &#0;", "2026-11-06T09:00:00.000Z"]
    ]);
  });
});
