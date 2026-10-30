import { describe, expect, it } from "vitest";
import {
  ErrorResponseSchema,
  EventsResponseSchema,
  isPublicHttpUrl,
  PublicEventSchema,
  RoomsResponseSchema,
  ScheduleItemSchema,
  SCHEDULE_CAMPUS_ID_MAX_LENGTH,
  SCHEDULE_DESCRIPTION_MAX_LENGTH,
  SCHEDULE_ID_MAX_LENGTH,
  SCHEDULE_LOCATION_MAX_LENGTH,
  SCHEDULE_RESPONSE_MAX_ITEMS,
  SCHEDULE_TITLE_MAX_LENGTH,
  ScheduleResponseSchema,
  TodayResponseSchema
} from "../index";

const RESPONSE_SCHEMA_CASES = [
  {
    name: "events",
    schema: EventsResponseSchema,
    payload: { events: [] },
    expectedMetadata: { _total: 2, _degraded: true, _sourcesConfigured: false },
  },
  {
    name: "rooms",
    schema: RoomsResponseSchema,
    payload: { rooms: [] },
    expectedMetadata: { _total: 2, _sourcesConfigured: false },
  },
  {
    name: "today",
    schema: TodayResponseSchema,
    payload: { events: [], rooms: [] },
    expectedMetadata: { _degraded: true, _sourcesConfigured: false },
  },
  {
    name: "schedule",
    schema: ScheduleResponseSchema,
    payload: { schedule: [] },
    expectedMetadata: { _total: 2, _degraded: true, _sourcesConfigured: false },
  },
] as const;

const METADATA_INPUT = {
  _total: 2,
  _degraded: true,
  _sourcesConfigured: false,
  ignored: "value",
} as const;

describe("@concourse/contracts public schemas", () => {
  it.each(RESPONSE_SCHEMA_CASES)("accepts $name responses without optional metadata", ({ schema, payload }) => {
    expect(schema.parse(payload)).toEqual(payload);
  });

  it.each(RESPONSE_SCHEMA_CASES)("keeps the exact public metadata boundary for $name", ({ expectedMetadata, payload, schema }) => {
    expect(schema.parse({ ...payload, ...METADATA_INPUT })).toEqual({ ...payload, ...expectedMetadata });
  });

  it.each(RESPONSE_SCHEMA_CASES)("rejects an invalid configured-source status for $name", ({ payload, schema }) => {
    expect(() => schema.parse({ ...payload, _sourcesConfigured: "true" })).toThrow();
  });

  it.each(RESPONSE_SCHEMA_CASES.filter(({ expectedMetadata }) => "_degraded" in expectedMetadata))(
    "rejects an invalid degraded status for $name",
    ({ payload, schema }) => {
      expect(() => schema.parse({ ...payload, _degraded: "true" })).toThrow();
    },
  );

  it.each(RESPONSE_SCHEMA_CASES.filter(({ expectedMetadata }) => "_total" in expectedMetadata))(
    "rejects a non-integer total for $name",
    ({ payload, schema }) => {
      expect(() => schema.parse({ ...payload, _total: 1.5 })).toThrow();
    },
  );

  it("matches the emitted public error envelope without internal error kinds", () => {
    expect(ErrorResponseSchema.parse({ error: { code: "bad_request", message: "Invalid query" } })).toEqual({
      error: { code: "bad_request", message: "Invalid query" }
    });
    expect(ErrorResponseSchema.parse({ error: { code: "bad_request", message: "Invalid query", kind: "validation" } })).toEqual({
      error: { code: "bad_request", message: "Invalid query" }
    });
  });

  it("enforces explicit public schedule text-field boundaries", () => {
    const item = {
      id: "i".repeat(SCHEDULE_ID_MAX_LENGTH),
      title: "t".repeat(SCHEDULE_TITLE_MAX_LENGTH),
      startsAt: "2026-07-14T18:00:00.000Z",
      location: "l".repeat(SCHEDULE_LOCATION_MAX_LENGTH),
      campusId: "c".repeat(SCHEDULE_CAMPUS_ID_MAX_LENGTH),
      description: "d".repeat(SCHEDULE_DESCRIPTION_MAX_LENGTH)
    };
    expect(ScheduleItemSchema.parse(item)).toEqual(item);
    expect(() => ScheduleItemSchema.parse({ ...item, id: `${item.id}x` })).toThrow();
    expect(() => ScheduleItemSchema.parse({ ...item, title: `${item.title}x` })).toThrow();
    expect(() => ScheduleItemSchema.parse({ ...item, location: `${item.location}x` })).toThrow();
    expect(() => ScheduleItemSchema.parse({ ...item, campusId: `${item.campusId}x` })).toThrow();
    expect(() => ScheduleItemSchema.parse({ ...item, description: `${item.description}x` })).toThrow();
  });

  it("rejects schedule collections above the public response ceiling", () => {
    const item = {
      id: "schedule-item",
      title: "Schedule item",
      startsAt: "2026-08-28T08:00:00.000Z"
    };
    expect(ScheduleResponseSchema.safeParse({
      schedule: Array.from({ length: SCHEDULE_RESPONSE_MAX_ITEMS + 1 }, () => item)
    }).success).toBe(false);
  });

  it("accepts HTTP(S) public event source URLs", () => {
    for (const sourceUrl of ["http://example.org/events/1", "https://example.org/events/1"]) {
      expect(() => PublicEventSchema.parse({
        id: "event-1",
        title: "Campus concert",
        date: "2026-07-14T18:00:00.000Z",
        sourceUrl
      })).not.toThrow();
    }
  });

  it.each([
    ["http://example.org/events/1", true],
    ["https://example.org/events/1", true],
    ["https://www.example.org/events/1", true],
    ["https://[2606:4700:4700::1111]/events/1", true],
    ["https://192.0.1.1/events/1", true],
    ["http://", false],
    ["https://?missing-host", false],
    ["javascript:alert(1)", false],
    ["ftp://example.org/events/1", false],
    ["https://reader:secret@example.org/events/1", false],
    ["https://localhost/events/1", false],
    ["https://intranet/events/1", false],
    ["https://events.local/events/1", false],
    ["https://127.0.0.1/events/1", false],
    ["https://10.0.0.1/events/1", false],
    ["https://[::1]/events/1", false],
    ["https://[fc00::1]/events/1", false],
    ["https://[2001:db8::1]/events/1", false],
  ])("classifies public HTTP(S) URL %s as %s", (sourceUrl, expected) => {
    expect(isPublicHttpUrl(sourceUrl)).toBe(expected);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "mailto:events@example.org",
    "ftp://example.org/events/1",
    "https://reader:secret@example.org/events/1",
    "https://localhost/events/1",
    "https://192.168.1.1/events/1",
    "https://[fe80::1]/events/1"
  ])(
    "rejects unsafe public event source URL %s",
    (sourceUrl) => {
      expect(() => PublicEventSchema.parse({
        id: "event-1",
        title: "Campus concert",
        date: "2026-07-14T18:00:00.000Z",
        sourceUrl
      })).toThrow();
    }
  );
});
