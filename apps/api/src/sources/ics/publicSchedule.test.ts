/** Verifies public schedule sources fail closed without leaking source credentials to logs. */

import { ScheduleResponseSchema, SCHEDULE_RESPONSE_MAX_ITEMS } from "@concourse/contracts";
import type { InstitutionPack } from "@concourse/institutions";
import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchTextWithTimeout, log } = vi.hoisted(() => ({
  fetchTextWithTimeout: vi.fn(),
  log: vi.fn()
}));

vi.mock("../upstream/httpClient", () => ({ fetchTextWithTimeout }));
vi.mock("../../runtime/logger", () => ({ log }));

import { clearCache } from "../upstream/cache";
import { fetchPublicSchedule } from "./publicSchedule";

afterEach(() => {
  clearCache();
  vi.clearAllMocks();
});

function institution(id: string, schedules: Array<{ label: string; url: string }>): InstitutionPack {
  return {
    id,
    name: "Example University",
    type: "university",
    campuses: [],
    publicSources: { schedules }
  };
}

const OPTIONS = { cacheTtlMs: 300_000, rruleHorizonDays: 90 };
function calendar(prefix: string, year: number, count: number): string {
  const events = Array.from({ length: count }, (_, index) => {
    const day = String(1 + (index % 28)).padStart(2, "0");
    const month = String(1 + Math.floor(index / 28) % 12).padStart(2, "0");
    const hour = String(Math.floor(index / 336) % 24).padStart(2, "0");
    return `BEGIN:VEVENT\nUID:${prefix}-${index}\nSUMMARY:${prefix} ${index}\nDTSTART:${year}${month}${day}T${hour}0000Z\nEND:VEVENT`;
  });
  return ["BEGIN:VCALENDAR", ...events, "END:VCALENDAR"].join("\n");
}

const VALID_CALENDAR = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:public\nSUMMARY:Open lecture\nDTSTART:20260101T100000Z\nEND:VEVENT\nEND:VCALENDAR";

describe("fetchPublicSchedule", () => {
  it("rejects a schedule source that bypassed pack validation without fetching or logging it", async () => {
    await expect(fetchPublicSchedule(institution("unsafe-schedule", [{
      label: "Campus calendar",
      url: "https://reader:secret@example.org/calendar.ics"
    }]), OPTIONS)).rejects.toThrow("All public schedule sources failed");

    expect(fetchTextWithTimeout).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("logs a stable label for a failed schedule source in a degraded partial result", async () => {
    fetchTextWithTimeout
      .mockResolvedValueOnce(VALID_CALENDAR)
      .mockRejectedValueOnce(new Error("request failed for https://reader:secret@example.org/calendar.ics"));

    const result = await fetchPublicSchedule(institution("safe-schedule-log", [
      { label: "Published calendar", url: "https://www.example.org/calendar.ics" },
      { label: "Events archive", url: "https://events.example.org/archive.ics" }
    ]), OPTIONS);

    expect(result.degraded).toBe(true);
    expect(result.schedule).toHaveLength(1);
    expect(log).toHaveBeenCalledWith("warn", "public_schedule_source_failed", {
      source: "Events archive",
      reason: "upstream_request_failed"
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("reader:secret");
  });

  it("keeps the merged schedule of several sources within the wire limit", async () => {
    fetchTextWithTimeout
      .mockResolvedValueOnce(calendar("lectures", 2099, 600))
      .mockResolvedValueOnce(calendar("concerts", 2098, 600));

    const result = await fetchPublicSchedule(institution("merged-limit", [
      { label: "Lectures", url: "https://www.example.org/lectures.ics" },
      { label: "Concerts", url: "https://www.example.org/concerts.ics" }
    ]), OPTIONS);

    expect(result.degraded).toBe(false);
    expect(result.schedule).toHaveLength(SCHEDULE_RESPONSE_MAX_ITEMS);
    expect(ScheduleResponseSchema.safeParse({ schedule: result.schedule }).success).toBe(true);
    const startTimes = result.schedule.map((item) => item.startsAt);
    expect(startTimes).toEqual([...startTimes].sort());
  });

  it("prefers upcoming occurrences over past ones when merged sources exceed the limit", async () => {
    fetchTextWithTimeout
      .mockResolvedValueOnce(calendar("archive", 2001, 900))
      .mockResolvedValueOnce(calendar("upcoming", 2099, 600));

    const result = await fetchPublicSchedule(institution("merged-upcoming", [
      { label: "Archive", url: "https://www.example.org/archive.ics" },
      { label: "Upcoming", url: "https://www.example.org/upcoming.ics" }
    ]), OPTIONS);

    expect(result.schedule).toHaveLength(SCHEDULE_RESPONSE_MAX_ITEMS);
    expect(result.schedule.filter((item) => item.id.startsWith("upcoming-"))).toHaveLength(600);
  });

  it("derives deterministic schedule items from source labels in mock mode without fetching", async () => {
    const date = new Date("2026-11-04T10:00:00.000Z");
    const pack = institution("mock-schedule", [
      { label: "Lectures", url: "https://www.example.org/lectures.ics" },
      { label: "Concerts", url: "https://www.example.org/concerts.ics" }
    ]);

    const first = await fetchPublicSchedule(pack, { ...OPTIONS, mode: "mock", date });
    clearCache();
    const second = await fetchPublicSchedule(pack, { ...OPTIONS, mode: "mock", date });

    expect(fetchTextWithTimeout).not.toHaveBeenCalled();
    expect(first).toEqual({
      degraded: false,
      schedule: [
        { id: expect.any(String), title: "Lectures", startsAt: "2026-11-04T10:00:00.000Z" },
        { id: expect.any(String), title: "Concerts", startsAt: "2026-11-04T10:00:00.000Z" }
      ]
    });
    expect(second).toEqual(first);
    const later = await fetchPublicSchedule(pack, { ...OPTIONS, mode: "mock", date: new Date("2026-11-05T10:00:00.000Z") });
    expect(later.schedule.map((item) => item.id)).toEqual(first.schedule.map((item) => item.id));
    expect(ScheduleResponseSchema.safeParse({ schedule: first.schedule }).success).toBe(true);
  });
});
