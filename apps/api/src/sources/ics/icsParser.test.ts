import { describe, expect, it } from "vitest";
import {
  SCHEDULE_DESCRIPTION_MAX_LENGTH,
  SCHEDULE_ID_MAX_LENGTH,
  SCHEDULE_TITLE_MAX_LENGTH
} from "@concourse/contracts";
import { parseIcs } from "./icsParser";

const calendar = (event: string) => `BEGIN:VCALENDAR\nBEGIN:VEVENT\n${event}\nEND:VEVENT\nEND:VCALENDAR`;

const calendarOf = (events: string[]) => `BEGIN:VCALENDAR\n${events.map((event) => `BEGIN:VEVENT\n${event}\nEND:VEVENT`).join("\n")}\nEND:VCALENDAR`;

describe("parseIcs", () => {
  it("normalizes public event fields without external fixture data", () => {
    expect(parseIcs(calendar("UID:event-1\nSUMMARY:Open\\, Lecture\nDTSTART:20260101T100000Z\nDTEND:20260101T110000Z\nLOCATION:Room \\; 101"))).toEqual([{
      id: "event-1", title: "Open, Lecture", startsAt: "2026-01-01T10:00:00.000Z",
      endsAt: "2026-01-01T11:00:00.000Z", location: "Room ; 101", campusId: undefined
    }]);
  });

  it("bounds recurring events and gives each occurrence a stable identity", () => {
    const events = parseIcs(calendar("UID:weekly\nSUMMARY:Seminar\nDTSTART:20260202T140000Z\nRRULE:FREQ=DAILY;COUNT=3"), { rruleHorizonDays: 30 });
    expect(events).toHaveLength(3);
    expect(new Set(events.map((event) => event.id)).size).toBe(3);
    expect(events.every((event) => event.isRecurring)).toBe(true);
  });

  it("rejects occurrences explicitly removed with EXDATE", () => {
    expect(parseIcs(calendar("UID:cancelled\nSUMMARY:Cancelled\nDTSTART:20260201T100000Z\nRRULE:FREQ=DAILY;COUNT=1\nEXDATE:20260201T100000Z"), { referenceDate: new Date("2026-01-01T00:00:00.000Z") })).toEqual([]);
  });

  it("bounds large text before recurrence expansion copies it into every occurrence", () => {
    const description = "D".repeat(60 * 1024);
    const events = Array.from({ length: 15 }, (_, index) => [
      "BEGIN:VEVENT",
      `UID:${"u".repeat(SCHEDULE_ID_MAX_LENGTH + 1)}-${index}`,
      `SUMMARY:${"S".repeat(SCHEDULE_TITLE_MAX_LENGTH + 1)}`,
      "DTSTART:20260101T100000Z",
      `DESCRIPTION:${description}`,
      "RRULE:FREQ=DAILY;COUNT=100",
      "END:VEVENT"
    ].join("\n"));
    const ics = `BEGIN:VCALENDAR\n${events.join("\n")}\nEND:VCALENDAR`;

    const parsed = parseIcs(ics, {
      referenceDate: new Date("2026-01-01T00:00:00.000Z"),
      rruleHorizonDays: 120
    });

    expect(ics.length).toBeGreaterThan(900 * 1024);
    expect(parsed).toHaveLength(1000);
    expect(parsed.every((event) => event.description?.length === SCHEDULE_DESCRIPTION_MAX_LENGTH)).toBe(true);
    expect(parsed.every((event) => event.title.length === SCHEDULE_TITLE_MAX_LENGTH)).toBe(true);
    expect(parsed.every((event) => event.id.length <= SCHEDULE_ID_MAX_LENGTH)).toBe(true);
  });

  it("does not retain a dangling UTF-16 surrogate when truncating schedule text", () => {
    const title = `${"S".repeat(SCHEDULE_TITLE_MAX_LENGTH - 1)}😀`;

    const [event] = parseIcs(calendar(`UID:utf-16-boundary\nSUMMARY:${title}\nDTSTART:20260101T100000Z`));

    expect(event.title).toBe("S".repeat(SCHEDULE_TITLE_MAX_LENGTH - 1));
    expect(event.title).not.toContain("\uFFFD");
  });

  it("rejects recurrence intervals that cannot make forward progress", () => {
    const [event] = parseIcs(calendar(
      "UID:negative-interval\nSUMMARY:Safe fallback\nDTSTART:20260202T140000Z\nRRULE:FREQ=DAILY;INTERVAL=-1"
    ), { referenceDate: new Date("2026-02-01T00:00:00.000Z") });

    expect(event).toMatchObject({ id: "negative-interval", title: "Safe fallback" });
    expect(event.isRecurring).toBeUndefined();
  });

  it("rejects filters whose dependency search is not horizon-bounded", () => {
    const [event] = parseIcs(calendar(
      "UID:impossible-filter\nSUMMARY:Safe fallback\nDTSTART:20260202T140000Z\nRRULE:FREQ=HOURLY;BYMONTH=2;BYMONTHDAY=30"
    ), { referenceDate: new Date("2026-02-01T00:00:00.000Z") });

    expect(event).toMatchObject({ id: "impossible-filter", title: "Safe fallback" });
    expect(event.isRecurring).toBeUndefined();
  });

  it("retains bounded weekly weekday recurrence", () => {
    const events = parseIcs(calendar(
      "UID:weekday-series\nSUMMARY:Workshop\nDTSTART:20260202T140000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4"
    ), { referenceDate: new Date("2026-02-01T00:00:00.000Z"), rruleHorizonDays: 30 });

    expect(events).toHaveLength(4);
    expect(events.every((event) => event.isRecurring)).toBe(true);
  });

  it("retains the same highest-priority events across input orders near the output limit", () => {
    const referenceDate = new Date("2026-06-01T00:00:00.000Z");
    const inputs = Array.from({ length: 1_004 }, (_, index) => {
      const startsAt = new Date(referenceDate.getTime() - 502 * 60_000 + Math.floor(index / 2) * 60_000)
        .toISOString().replaceAll(/[-:]/g, "").replace(".000Z", "Z");
      return `UID:event-${String(index).padStart(4, "0")}\nSUMMARY:Shared ${index % 3}\nDTSTART:${startsAt}`;
    });
    const alternating = Array.from({ length: inputs.length }, (_, index) =>
      inputs[index % 2 === 0 ? index / 2 : inputs.length - 1 - Math.floor(index / 2)]!
    );
    const parse = (ordered: string[]) => parseIcs(calendarOf(ordered), { maxTotalEvents: 1_000, referenceDate });

    const ascending = parse(inputs);
    expect(parse([...inputs].reverse())).toEqual(ascending);
    expect(parse(alternating)).toEqual(ascending);
    expect(ascending).toHaveLength(1_000);
  });
});

describe("parseIcs time zones and overrides", () => {
  const berlin = (referenceDate: string, extra: Record<string, unknown> = {}) =>
    ({ timeZone: "Europe/Berlin", referenceDate: new Date(referenceDate), ...extra });
  const series = "UID:s\nSUMMARY:Lecture\nDTSTART;TZID=Europe/Berlin:20261102T100000\nRRULE:FREQ=WEEKLY;COUNT=3";
  const moved = "UID:s\nSUMMARY:Lecture (moved)\nRECURRENCE-ID;TZID=Europe/Berlin:20261109T100000\nDTSTART;TZID=Europe/Berlin:20261110T140000";
  const options = berlin("2026-11-01T00:00:00.000Z");

  it("T-1/T-2: reads floating times in the pack zone in winter and summer", () => {
    expect(parseIcs(calendar("UID:w\nSUMMARY:W\nDTSTART:20261105T190000"), berlin("2026-11-01T00:00:00.000Z"))[0].startsAt)
      .toBe("2026-11-05T18:00:00.000Z");
    expect(parseIcs(calendar("UID:s\nSUMMARY:S\nDTSTART:20260605T190000"), berlin("2026-05-01T00:00:00.000Z"))[0].startsAt)
      .toBe("2026-06-05T17:00:00.000Z");
  });

  it("T-3: reads all-day dates as local midnight in the pack zone", () => {
    const [event] = parseIcs(calendar("UID:d\nSUMMARY:D\nDTSTART;VALUE=DATE:20261105\nDTEND;VALUE=DATE:20261106"), options);
    expect(event).toMatchObject({ startsAt: "2026-11-04T23:00:00.000Z", endsAt: "2026-11-05T23:00:00.000Z" });
  });

  it("T-4: replaces a moved occurrence with its override under the original slot id", () => {
    const unmoved = parseIcs(calendar(series), options);
    for (const events of [parseIcs(calendarOf([series, moved]), options), parseIcs(calendarOf([moved, series]), options)]) {
      expect(events.map((event) => event.startsAt)).toEqual([
        "2026-11-02T09:00:00.000Z", "2026-11-10T13:00:00.000Z", "2026-11-16T09:00:00.000Z"
      ]);
      expect(new Set(events.map((event) => event.id)).size).toBe(3);
      expect(events[1]).toMatchObject({ title: "Lecture (moved)", id: unmoved[1].id });
    }
  });

  it("T-5: drops cancelled occurrences, events and series", () => {
    const cancelledSlot = "UID:s\nSUMMARY:Lecture\nSTATUS:CANCELLED\nRECURRENCE-ID;TZID=Europe/Berlin:20261116T100000\nDTSTART;TZID=Europe/Berlin:20261116T100000";
    expect(parseIcs(calendarOf([series, moved, cancelledSlot]), options).map((event) => event.startsAt))
      .toEqual(["2026-11-02T09:00:00.000Z", "2026-11-10T13:00:00.000Z"]);
    expect(parseIcs(calendar("UID:c\nSUMMARY:Cancelled talk\nSTATUS:CANCELLED\nDTSTART:20261105T190000"), options)).toEqual([]);
    expect(parseIcs(calendar(`${series}\nSTATUS:CANCELLED`), options)).toEqual([]);
  });

  it("T-6: falls back to the pack zone for a non-IANA TZID", () => {
    const events = parseIcs(calendar("UID:o\nSUMMARY:O\nDTSTART;TZID=W. Europe Standard Time:20261105T190000"), options);
    expect(events.map((event) => event.startsAt)).toEqual(["2026-11-05T18:00:00.000Z"]);
  });

  it("T-7: keeps an all-day series on its local day across DST", () => {
    const starts = parseIcs(calendar("UID:m\nSUMMARY:M\nDTSTART;VALUE=DATE:20260701\nRRULE:FREQ=MONTHLY;COUNT=6"),
      berlin("2026-06-01T00:00:00.000Z", { rruleHorizonDays: 366 })).map((event) => event.startsAt);
    expect(starts).toContain("2026-06-30T22:00:00.000Z");
    expect(starts).toContain("2026-10-31T23:00:00.000Z");
  });

  it("PA-8: decodes text escapes in one pass", () => {
    const [event] = parseIcs(calendar("UID:e\nSUMMARY:a\\, b\\; c\\nd\nDTSTART:20261105T190000Z\nDESCRIPTION:C:\\\\new"));
    expect(event.description).toBe("C:\\new");
    expect(event.title).toBe("a, b; c\nd");
  });
});

describe("parseIcs override and all-day edge cases", () => {
  const options = { timeZone: "Europe/Berlin", referenceDate: new Date("2026-11-01T00:00:00.000Z") };

  it("keeps an override with a malformed RECURRENCE-ID under a stable unique id", () => {
    const events = parseIcs(calendarOf([
      "UID:s\nSUMMARY:Lecture\nDTSTART;TZID=Europe/Berlin:20261102T100000\nRRULE:FREQ=WEEKLY;COUNT=2",
      "UID:s\nSUMMARY:Moved\nRECURRENCE-ID:not-a-date\nDTSTART;TZID=Europe/Berlin:20261110T140000"
    ]), options);
    expect(events.map((event) => event.title)).toEqual(["Lecture", "Lecture", "Moved"]);
    expect(new Set(events.map((event) => event.id)).size).toBe(3);
  });

  it("applies a UID's overridden slots to its first master only", () => {
    const master = (title: string) => `UID:s\nSUMMARY:${title}\nDTSTART;TZID=Europe/Berlin:20261102T100000\nRRULE:FREQ=WEEKLY;COUNT=3`;
    const moved = "UID:s\nSUMMARY:Moved\nRECURRENCE-ID;TZID=Europe/Berlin:20261109T100000\nDTSTART;TZID=Europe/Berlin:20261110T140000";
    const slot = parseIcs(calendarOf([master("First"), master("Duplicate"), moved]), options)
      .filter((event) => event.startsAt === "2026-11-09T09:00:00.000Z");
    expect(slot.map((event) => event.title)).toEqual(["Duplicate"]);
  });

  it("expands a series whose only zone is a non-IANA TZID", () => {
    const events = parseIcs(calendar("UID:win\nSUMMARY:Win\nDTSTART;TZID=W. Europe Standard Time:20261105T190000\nRRULE:FREQ=WEEKLY;COUNT=3"), options);
    expect(events.map((event) => event.startsAt)).toEqual([
      "2026-11-05T18:00:00.000Z", "2026-11-12T18:00:00.000Z", "2026-11-19T18:00:00.000Z"
    ]);
  });

  it("keeps the exact duration of a timed zoned occurrence across the DST night", () => {
    const events = parseIcs(calendar("UID:n\nSUMMARY:Night\nDTSTART;TZID=Europe/Berlin:20261017T220000\nDTEND;TZID=Europe/Berlin:20261018T040000\nRRULE:FREQ=WEEKLY;COUNT=2"),
      { timeZone: "Europe/Berlin", referenceDate: new Date("2026-10-01T00:00:00.000Z") });
    expect(events.map((event) => [event.startsAt, event.endsAt])).toEqual([
      ["2026-10-17T20:00:00.000Z", "2026-10-18T02:00:00.000Z"],
      ["2026-10-24T20:00:00.000Z", "2026-10-25T02:00:00.000Z"]
    ]);
  });

  it("ends a zoned all-day occurrence at local midnight on a DST-change day", () => {
    const events = parseIcs(calendar("UID:d\nSUMMARY:Day\nDTSTART;VALUE=DATE:20261024\nDTEND;VALUE=DATE:20261025\nRRULE:FREQ=DAILY;COUNT=2"),
      { timeZone: "Europe/Berlin", referenceDate: new Date("2026-10-20T00:00:00.000Z") });
    expect(events.map((event) => [event.startsAt, event.endsAt])).toEqual([
      ["2026-10-23T22:00:00.000Z", "2026-10-24T22:00:00.000Z"],
      ["2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z"]
    ]);
  });
});
