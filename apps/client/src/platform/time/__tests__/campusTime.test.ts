/** Pins campus day boundaries on DST days, midnight transitions and half-hour zones (P-6). */
import { describe, expect, it } from "vitest";
import { getCampusDate, getCampusDayRange, millisecondsUntilNextCampusDay } from "../campusTime";

const HOUR_MS = 60 * 60 * 1000;

describe("getCampusDayRange", () => {
  it.each([
    ["Berlin spring-forward day (23 h)", "Europe/Berlin", "2026-03-29T12:00:00Z", "2026-03-28T23:00:00.000Z", "2026-03-29T21:59:59.999Z"],
    ["Berlin fall-back day (25 h)", "Europe/Berlin", "2026-10-25T12:00:00Z", "2026-10-24T22:00:00.000Z", "2026-10-25T22:59:59.999Z"],
    ["Havana day whose midnight does not exist", "America/Havana", "2026-03-08T12:00:00Z", "2026-03-08T05:00:00.000Z", "2026-03-09T03:59:59.999Z"],
    ["Kolkata half-hour offset", "Asia/Kolkata", "2026-06-15T12:00:00Z", "2026-06-14T18:30:00.000Z", "2026-06-15T18:29:59.999Z"]
  ])("returns the exact bounds of the %s", (_label, timeZone, at, from, to) => {
    expect(getCampusDayRange(new Date(at), timeZone)).toEqual({ from, to });
  });
});

describe("campus date rollover", () => {
  it("uses the campus date, not the device date, just after campus midnight", () => {
    expect(getCampusDate(new Date("2026-03-28T23:00:00Z"), "Europe/Berlin")).toBe("2026-03-29");
    expect(getCampusDate(new Date("2026-03-28T22:59:59Z"), "Europe/Berlin")).toBe("2026-03-28");
  });

  it("waits 23 hours from the start of a spring-forward day", () => {
    expect(millisecondsUntilNextCampusDay(new Date("2026-03-28T23:00:00Z"), "Europe/Berlin")).toBe(23 * HOUR_MS);
  });
});
