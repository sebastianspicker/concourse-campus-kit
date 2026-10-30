/** Characterizes Today status precedence, schedule selection, and card shaping. */
import { describe, expect, it } from "vitest";
import type { ScheduleItem, ScheduleResponse } from "@concourse/contracts";
import { getThemeForScheme } from "@/design-system/themeResolve";
import { en } from "@/localization/dictionaries";
import { getBoardPresentation, getTodayChromeStatus, getTodaySourceStatus } from "../todaySourceStatus";
import {
  TODAY_SCHEDULE_LIMIT,
  getCurrentOrNextScheduleId,
  getNowAndNext,
  getScheduleCard,
  getScheduleEntryState,
  getTodaySchedule,
  isScheduleUnavailable,
  sortScheduleItems,
} from "../todayScreenHelpers";

const theme = getThemeForScheme("light");
const t = ((key: keyof typeof en) => en[key]) as Parameters<typeof getTodaySourceStatus>[0]["t"];
const flags = { cached: false, degraded: false, loading: false, unavailable: false };

function status(overrides: Partial<typeof flags>) {
  return getTodaySourceStatus({ ...flags, ...overrides, theme, t });
}

function item(id: string, startsAt: string, endsAt?: string, location?: string): ScheduleItem {
  return { id, title: `Item ${id}`, startsAt, endsAt, location } as ScheduleItem;
}

describe("getTodaySourceStatus", () => {
  it("prefers unavailable, then degraded, cached, loading, and finally success", () => {
    const all = { cached: true, degraded: true, loading: true, unavailable: true };
    expect(status(all)).toMatchObject({ tone: "error", label: en.publicSourcesUnavailable, color: theme.colors.error, lamp: "crossed" });
    expect(status({ ...all, unavailable: false })).toMatchObject({ tone: "warning", label: en.publicSourcesLimited, lamp: "half" });
    expect(status({ cached: true, loading: true })).toMatchObject({ tone: "warning", label: en.publicSourcesCached, lamp: "hollow" });
    expect(status({ loading: true })).toMatchObject({ tone: "muted", label: en.publicSourcesChecking, color: theme.colors.muted, lamp: "hollow" });
    expect(status({})).toMatchObject({ tone: "success", color: theme.colors.success, lamp: "filled" });
  });
});

describe("getTodayChromeStatus", () => {
  it("shortens only the success label on phones and passes other states through", () => {
    const ok = status({});
    expect(getTodayChromeStatus(ok, t, theme.colors, true)).toEqual({
      tone: "success",
      color: theme.colors.success,
      label: en.statusCurrent,
      lamp: "filled",
    });
    expect(getTodayChromeStatus(ok, t, theme.colors, false).label).toBe(en.publicSourcesCurrent);
    const degraded = status({ degraded: true });
    expect(getTodayChromeStatus(degraded, t, theme.colors, false)).toEqual({
      tone: "warning",
      color: degraded.color,
      label: degraded.label,
      lamp: "half",
    });
    expect(getTodayChromeStatus(degraded, t, theme.colors, true).label).toBe(en.statusLimited);
    expect(getTodayChromeStatus(status({ cached: true }), t, theme.colors, true).label).toBe(en.statusSaved);
    expect(getTodayChromeStatus(status({ unavailable: true }), t, theme.colors, true).label).toBe(en.statusUnavailable);
    expect(getTodayChromeStatus(status({ loading: true }), t, theme.colors, true).label).toBe(en.statusChecking);
  });
});

describe("schedule helpers", () => {
  const morning = item("a", "2026-09-14T08:00:00Z", "2026-09-14T09:00:00Z");
  const noon = item("b", "2026-09-14T12:00:00Z", "2026-09-14T13:00:00Z");
  const evening = item("c", "2026-09-14T18:00:00Z");

  it("sorts a copy by start time in either direction", () => {
    const input = [noon, evening, morning];
    expect(sortScheduleItems(input, "asc").map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(sortScheduleItems(input, "desc").map((i) => i.id)).toEqual(["c", "b", "a"]);
    expect(input.map((i) => i.id)).toEqual(["b", "c", "a"]);
  });

  it("prefers the ongoing item, otherwise the nearest future one", () => {
    const items = [evening, noon, morning];
    expect(getCurrentOrNextScheduleId(items, new Date("2026-09-14T08:30:00Z"))).toBe("a");
    expect(getCurrentOrNextScheduleId(items, new Date("2026-09-14T09:30:00Z"))).toBe("b");
    expect(getCurrentOrNextScheduleId(items, new Date("2026-09-14T19:00:00Z"))).toBeUndefined();
    expect(getCurrentOrNextScheduleId([], new Date())).toBeUndefined();
  });

  it("limits the slice while preserving the reported total", () => {
    const many = Array.from({ length: TODAY_SCHEDULE_LIMIT + 5 }, (_, i) =>
      item(String(i), new Date(Date.UTC(2026, 8, 14, 0, i)).toISOString()),
    );
    const slice = getTodaySchedule({ schedule: many } as ScheduleResponse, "asc");
    expect(slice.items).toHaveLength(TODAY_SCHEDULE_LIMIT);
    expect(slice.total).toBe(many.length);
    expect(getTodaySchedule({ schedule: many, _total: 99 } as ScheduleResponse, "asc").total).toBe(99);
    expect(getTodaySchedule(null, "asc")).toEqual({ items: [], total: 0 });
  });

  it("treats unavailable and not-found errors as unavailable schedules", () => {
    expect(isScheduleUnavailable({ kind: "unavailableSource" })).toBe(true);
    expect(isScheduleUnavailable({ kind: "notFound" })).toBe(true);
    expect(isScheduleUnavailable({ kind: "offline" })).toBe(false);
    expect(isScheduleUnavailable(null)).toBe(false);
  });

  it("shapes a schedule row with a 24-hour time column and a to-be-announced fallback", () => {
    const withRoom = getScheduleCard(item("x", "2026-09-14T08:00:00Z", "2026-09-14T09:00:00Z", "Room 1"), "en", "UTC", "TBA");
    expect(withRoom).toMatchObject({ title: "Item x", subtitle: "Room 1", leading: "08:00", leadingDetail: "09:00", dimmed: false });
    expect(getScheduleCard(item("y", "2026-09-14T08:00:00Z"), "en", "UTC", "TBA")).toMatchObject({ subtitle: "TBA", leadingDetail: undefined });
    const labels = { now: "Now", next: "Next", ended: "Ended" };
    expect(getScheduleCard(item("z", "2026-09-14T08:00:00Z"), "en", "UTC", "TBA", "now", labels).status).toEqual({ kind: "now", label: "Now" });
    expect(getScheduleCard(item("z", "2026-09-14T08:00:00Z"), "en", "UTC", "TBA", "ended", labels)).toMatchObject({ dimmed: true, status: { kind: "ended" } });
    expect(getScheduleCard(item("z", "2026-09-14T08:00:00Z"), "en", "UTC", "TBA", "later", labels).status).toBeUndefined();
  });

  it("selects now and next from real times, independent of sort order", () => {
    const items = [evening, noon, morning];
    expect(getNowAndNext(items, new Date("2026-09-14T08:30:00Z"))).toEqual({ current: morning, next: noon });
    expect(getNowAndNext(items, new Date("2026-09-14T10:00:00Z"))).toEqual({ current: undefined, next: noon });
    expect(getNowAndNext(items, new Date("2026-09-14T19:00:00Z"))).toEqual({ current: undefined, next: undefined });
  });

  it("classifies entries as now, next, ended, or later", () => {
    const at = new Date("2026-09-14T12:30:00Z");
    const selection = getNowAndNext([morning, noon, evening], at);
    expect(getScheduleEntryState(noon, selection, at)).toBe("now");
    expect(getScheduleEntryState(evening, selection, at)).toBe("next");
    expect(getScheduleEntryState(morning, selection, at)).toBe("ended");
    const openEnded = item("d", "2026-09-14T06:00:00Z");
    expect(getScheduleEntryState(openEnded, selection, at)).toBe("later");
    const parallel = item("p", "2026-09-14T12:15:00Z", "2026-09-14T12:45:00Z");
    expect(getScheduleEntryState(parallel, getNowAndNext([noon, parallel], at), at)).toBe("now");
  });

  it("never claims anything the schedule does not say on the board", () => {
    const base = { locale: "en", timeZone: "UTC", translate: t };
    const ready = { kind: "ready" } as const;
    const empty = getBoardPresentation({ ...base, current: undefined, next: undefined, schedule: ready });
    expect(empty.now).toMatchObject({ title: en.nothingNow, empty: true });
    expect(empty.next).toMatchObject({ title: en.nothingNext, empty: true });
    const busy = getBoardPresentation({ ...base, current: item("n", "2026-09-14T12:00:00Z", "2026-09-14T13:00:00Z", "Studio A"), next: undefined, schedule: ready });
    expect(busy.now).toMatchObject({ title: "Item n", meta: "12:00 - 13:00 · Studio A", empty: false });
    const unavailable = getBoardPresentation({ ...base, current: undefined, next: undefined, schedule: { kind: "unavailable", reason: en.errorServer } });
    expect(unavailable.now).toMatchObject({ title: en.scheduleNotAvailable, meta: null, note: en.errorServer, empty: true });
    expect(unavailable.next).toBeNull();
    const loading = getBoardPresentation({ ...base, current: undefined, next: undefined, schedule: { kind: "loading" } });
    expect(loading.now).toMatchObject({ title: en.checkingSchedule, empty: true });
    expect(loading.next).toBeNull();
  });
});
