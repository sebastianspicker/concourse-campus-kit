/** Verifies public BFF route, validation, retry, and persisted-fallback contracts. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: async (key: string) => {
      values.delete(key);
    },
    getAllKeys: async () => [...values.keys()],
    multiRemove: async (keys: readonly string[]) => {
      for (const key of keys) values.delete(key);
    },
  };
});

const staticDemo = vi.hoisted(() => ({ enabled: false }));

vi.mock("@react-native-async-storage/async-storage", () => ({ default: storage }));
vi.mock("@/platform/env/env", () => ({ getBffBaseUrl: () => "https://api.example.test" }));
vi.mock("@/platform/env/institution", () => ({ getConfiguredInstitutionId: () => "example", getInstitutionTimeZone: () => "Europe/Berlin" }));
vi.mock("@/data/public/staticDemo", () => ({ isStaticDemo: () => staticDemo.enabled }));

import { ApiErrorException } from "@/platform/http/errors";
import { toUiError } from "@/platform/http/uiError";
import { clearCache } from "../cache";
import { getPublicCacheKey } from "../publicCacheKey";
import { fetchEvents, fetchRooms, fetchSchedule, fetchToday } from "../publicApi";
import { clearPersistedCache, fetchNetworkFirstWithFallback, setPersistedCache } from "../persistedCache";
import { parseRetryAfterSeconds } from "@/platform/http/retry";

const event = {
  id: "open-house",
  title: "Open house",
  date: "2026-09-14T09:00:00.000Z",
  sourceUrl: "https://example.test/events/open-house",
};
const room = { id: "library", name: "Library", campusId: "main" };
const scheduleItem = {
  id: "orientation",
  title: "Orientation",
  startsAt: "2026-09-14T08:00:00.000Z",
};

function jsonResponse(body: unknown, institutionId = "example", status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-institution-id": institutionId, ...headers },
  });
}

describe("public BFF data contract", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    storage.values.clear();
    clearCache();
    fetchMock.mockReset();
    staticDemo.enabled = false;
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    clearCache();
    await clearPersistedCache();
    staticDemo.enabled = false;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns validated fictional fixtures in static demo mode without fetching the BFF", async () => {
    staticDemo.enabled = true;

    const [events, rooms, today, schedule] = await Promise.all([
      fetchEvents({ force: true }),
      fetchRooms({ search: "library", force: true }),
      fetchToday({ date: "2026-09-14", force: true }),
      fetchSchedule({ from: "2026-09-14", force: true }),
    ]);

    expect(events).toMatchObject({ source: "memory-cache", data: { _sourcesConfigured: true } });
    expect(events.data.events).toContainEqual(expect.objectContaining({ id: "welcome-concert", title: "Welcome concert" }));
    expect(rooms).toMatchObject({ source: "memory-cache", data: { _sourcesConfigured: true } });
    expect(rooms.data.rooms).toContainEqual(expect.objectContaining({ id: "library", name: "Library" }));
    expect(today).toMatchObject({ source: "memory-cache", data: { _degraded: false } });
    expect(today.data.events).toContainEqual(expect.objectContaining({ id: "welcome-concert" }));
    expect(today.data.rooms).toContainEqual(expect.objectContaining({ id: "auditorium" }));
    expect(schedule).toMatchObject({ source: "memory-cache", data: { _sourcesConfigured: true } });
    expect(schedule.data.schedule).toContainEqual(expect.objectContaining({ id: "orientation", title: "Campus orientation" }));

    // Today asks for its schedule with campus-day bounds as UTC instants; the fixture must follow that day.
    const campusDay = await fetchSchedule({ from: "2026-10-02T22:00:00.000Z", to: "2026-10-03T21:59:59.999Z", force: true });
    expect(campusDay.data.schedule.every((item) => item.startsAt.startsWith("2026-10-03"))).toBe(true);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests all public routes and serializes only endpoint filters", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ events: [event], _total: 1 }))
      .mockResolvedValueOnce(jsonResponse({ rooms: [room], _total: 1 }))
      .mockResolvedValueOnce(jsonResponse({ events: [event], rooms: [room] }))
      .mockResolvedValueOnce(jsonResponse({ schedule: [scheduleItem], _total: 1 }));

    await expect(fetchEvents({
      search: "open house",
      from: "2026-09-14T00:00:00.000Z",
      to: "2026-09-14T23:59:59.999Z",
      limit: 5,
      offset: 0,
      force: true,
    })).resolves.toMatchObject({ data: { events: [event] }, source: "network" });
    await expect(fetchRooms({ campus: "main", search: "library", limit: 10, offset: 0, force: true })).resolves.toMatchObject({ data: { rooms: [room] } });
    await expect(fetchToday({ date: "2026-09-14", force: true })).resolves.toMatchObject({ data: { events: [event], rooms: [room] } });
    await expect(fetchSchedule({ campus: "main", search: "orientation", from: "2026-09-14T00:00:00.000Z", to: "2026-09-14T23:59:59.999Z", limit: 5, offset: 0, force: true })).resolves.toMatchObject({ data: { schedule: [scheduleItem] } });

    const requests = fetchMock.mock.calls.map(([url]) => new URL(String(url)));
    expect(requests.map((url) => url.pathname)).toEqual(["/events", "/rooms", "/today", "/schedule"]);
    expect(Object.fromEntries(requests[0]!.searchParams)).toEqual({
      search: "open house",
      from: "2026-09-14T00:00:00.000Z",
      to: "2026-09-14T23:59:59.999Z",
      limit: "5",
      offset: "0",
    });
    expect(Object.fromEntries(requests[1]!.searchParams)).toEqual({ campus: "main", search: "library", limit: "10", offset: "0" });
    expect(Object.fromEntries(requests[2]!.searchParams)).toEqual({ date: "2026-09-14" });
    expect(Object.fromEntries(requests[3]!.searchParams)).toEqual({
      campus: "main",
      search: "orientation",
      from: "2026-09-14T00:00:00.000Z",
      to: "2026-09-14T23:59:59.999Z",
      limit: "5",
      offset: "0",
    });
  });

  it("rejects a schema-invalid API response as a normalized validation failure", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ events: [{ ...event, sourceUrl: undefined }] }));

    await expect(fetchEvents({ force: true })).rejects.toMatchObject({ code: "validation_error", status: 502 });
    expect(toUiError(new ApiErrorException({ code: "validation_error", status: 502, message: "invalid" }))).toEqual({ kind: "invalidResponse" });
  });

  it("coalesces forced validation failures without exposing an invalid response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ events: [{ ...event, sourceUrl: undefined }] }));

    const results = await Promise.allSettled([
      fetchEvents({ force: true }),
      fetchEvents({ force: true }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ code: "validation_error" }) }),
      expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ code: "validation_error" }) }),
    ]);
  });

  it("keeps network-first and explicit memory request cohorts independent", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ events: [event] }))
      .mockResolvedValueOnce(jsonResponse({ events: [event] }));

    const [memory, persisted] = await Promise.all([
      fetchEvents({ force: true }),
      fetchEvents({ force: true, offlineMode: true }),
    ]);

    expect(memory.source).toBe("network");
    expect(persisted.source).toBe("network");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses completed memory only for the explicit non-persisted request path", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ rooms: [room] }));

    await expect(fetchRooms()).resolves.toMatchObject({ source: "network" });
    await expect(fetchRooms()).resolves.toMatchObject({ source: "memory-cache" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects data served for a different institution before it reaches a resource", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ rooms: [room] }, "another-campus"));

    await expect(fetchRooms({ force: true })).rejects.toMatchObject({ code: "institution_mismatch", status: 409 });
    expect(toUiError(new ApiErrorException({ code: "institution_mismatch", status: 409, message: "mismatch" }))).toEqual({ kind: "institutionMismatch" });
  });

  it("retries transient fetched responses and retains Retry-After guidance in the final semantic error", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { code: "upstream_unavailable", message: "try later" } }, "example", 503))
      .mockResolvedValueOnce(jsonResponse({ events: [event], rooms: [room] }));

    const result = fetchToday({ force: true });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toMatchObject({ data: { events: [event], rooms: [room] } });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(
      { error: { code: "rate_limited", message: "wait" } },
      "example",
      429,
      { "retry-after": "1" },
    )));
    const exhausted = fetchToday({ force: true });
    const capturedError = exhausted.then(
      () => new Error("Expected the rate-limited request to fail"),
      (reason: unknown) => reason,
    );
    await vi.advanceTimersByTimeAsync(3_000);
    const error = await capturedError;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(toUiError(error)).toEqual({ kind: "rateLimit", retryAfterInSeconds: 1 });
    expect(parseRetryAfterSeconds("-10")).toBe(0);
  });

  it("uses only fresh validated persisted data for eligible transient failures", async () => {
    const eligibleKey = getPublicCacheKey("events", { search: "open house" });
    const ineligibleKey = getPublicCacheKey("rooms", { campus: "main" });
    await setPersistedCache(eligibleKey, { events: [event] });
    await setPersistedCache(ineligibleKey, { rooms: [room] });

    await expect(fetchNetworkFirstWithFallback(
      eligibleKey,
      async () => Promise.reject(new ApiErrorException({ code: "upstream_unavailable", status: 503, message: "down" })),
      (value): value is { events: (typeof event)[] } => typeof value === "object" && value !== null && "events" in value,
    )).resolves.toMatchObject({ data: { events: [event] }, fromCache: true, isOffline: true });

    await expect(fetchNetworkFirstWithFallback(
      ineligibleKey,
      async () => Promise.reject(new ApiErrorException({ code: "validation_error", status: 502, message: "invalid" })),
      (value): value is { rooms: (typeof room)[] } => typeof value === "object" && value !== null && "rooms" in value,
    )).rejects.toMatchObject({ code: "validation_error", status: 502 });
  });

  it("advances persisted cache age across repeated network-first fallbacks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T10:00:00Z"));
    const key = getPublicCacheKey("events", { search: "saved" });
    await setPersistedCache(key, { events: [event] });
    fetchMock.mockRejectedValue(new TypeError("offline"));

    const firstRequest = fetchEvents({ search: "saved", force: true, offlineMode: true });
    await vi.advanceTimersByTimeAsync(3_000);
    const first = await firstRequest;
    await vi.advanceTimersByTimeAsync(5_000);
    const secondRequest = fetchEvents({ search: "saved", offlineMode: true });
    let secondResolvedAt = 0;
    const observedSecond = secondRequest.then((result) => {
      secondResolvedAt = Date.now();
      return result;
    });
    await vi.advanceTimersByTimeAsync(3_000);
    const second = await observedSecond;

    expect(first.source).toBe("persisted-cache");
    expect(second.source).toBe("persisted-cache");
    expect(second.cacheAge).toBe(secondResolvedAt - second.updatedAt);
    expect(second.cacheAge).toBeGreaterThan((first.cacheAge ?? 0) + 5_000);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("serves saved data instead of a timeout when Retry-After exceeds the request budget", async () => {
    vi.useFakeTimers();
    const key = getPublicCacheKey("events", { search: "limited" });
    await setPersistedCache(key, { events: [event] });
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(
      { error: { code: "rate_limited", message: "wait" } }, "example", 429, { "retry-after": "20" },
    )));

    const request = fetchEvents({ search: "limited", force: true, offlineMode: true });
    const outcome = request.then((result) => result, (reason: unknown) => reason);
    await vi.advanceTimersByTimeAsync(16_000);

    expect(await outcome).toMatchObject({ source: "persisted-cache", data: { events: [event] } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports the rate limit instead of a timeout when Retry-After exceeds the request budget and nothing is saved", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(
      { error: { code: "rate_limited", message: "wait" } }, "example", 429, { "retry-after": "20" },
    )));

    const request = fetchEvents({ search: "unsaved", force: true, offlineMode: true });
    const outcome = request.then(() => new Error("Expected the rate-limited request to fail"), (reason: unknown) => reason);
    await vi.advanceTimersByTimeAsync(16_000);

    expect(toUiError(await outcome)).toEqual({ kind: "rateLimit", retryAfterInSeconds: 20 });
  });

  it("serves saved data when a slow server error and a hanging retry exhaust the request budget", async () => {
    vi.useFakeTimers();
    const key = getPublicCacheKey("events", { search: "slow" });
    await setPersistedCache(key, { events: [event] });
    fetchMock
      .mockImplementationOnce(() => new Promise((resolve) => {
        setTimeout(() => resolve(jsonResponse({ error: { code: "upstream_unavailable", message: "slow" } }, "example", 503)), 9_000);
      }))
      .mockImplementation((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }));

    const request = fetchEvents({ search: "slow", force: true, offlineMode: true });
    const outcome = request.then((result) => result, (reason: unknown) => reason);
    await vi.advanceTimersByTimeAsync(16_000);

    expect(await outcome).toMatchObject({ source: "persisted-cache", data: { events: [event] } });
  });
});
