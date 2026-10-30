/** Characterizes cache compatibility and deterministic static-demo data for the mobile client. */

import { afterEach, describe, expect, it, vi } from "vitest";

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
    }
  };
});

vi.mock("@react-native-async-storage/async-storage", () => ({ default: storage }));
vi.mock("@/platform/env/env", () => ({ getBffBaseUrl: () => "https://api.example.test" }));
vi.mock("@/platform/env/institution", () => ({
  getConfiguredInstitutionId: () => "mockuni",
  getInstitutionTimeZone: () => "Europe/Berlin",
}));

import {
  CACHE_STORAGE_NAMESPACE,
  clearPersistedCache,
  fetchNetworkFirstWithFallback,
  isOfflineData,
  setPersistedCache
} from "../persistedCache";
import { getPublicCacheKey } from "../publicCacheKey";
import { getStaticDemoResponse } from "../staticDemoData";
import { getCached } from "../cache";
import { clearPublicDataState, subscribePublicDataClear } from "../publicDataLifecycle";
import { selectedEventDetails } from "../selectedDetailRecords";

afterEach(async () => {
  await clearPersistedCache();
  storage.values.clear();
});

describe("mobile cache and static-demo characterization", () => {
  it("migrates a valid legacy cache entry into the concourse namespace", async () => {
    const key = getPublicCacheKey("rooms");
    const raw = JSON.stringify({ data: { name: "Auditorium" }, timestamp: Date.now() });
    storage.values.set(`campus-app-kit:${key}`, raw);

    await expect(fetchNetworkFirstWithFallback(
      key,
      async () => Promise.reject(new TypeError("network unavailable")),
      (value): value is { name: string } => typeof value === "object" && value !== null && "name" in value,
    )).resolves.toMatchObject({ data: { name: "Auditorium" }, fromCache: true, isOffline: true });

    expect(JSON.parse(storage.values.get(`${CACHE_STORAGE_NAMESPACE}${key}`) ?? "{}"))
      .toMatchObject({ data: { name: "Auditorium" }, isOffline: true });
    expect(storage.values.has(`campus-app-kit:${key}`)).toBe(false);
  });

  it("clears both cache namespaces for a specific resource key", async () => {
    const key = getPublicCacheKey("rooms");
    storage.values.set(`concourse:${key}`, "current");
    storage.values.set(`campus-app-kit:${key}`, "legacy");
    storage.values.set("concourse:language-preference", "de");

    await clearPersistedCache(key);

    expect(storage.values.has(`concourse:${key}`)).toBe(false);
    expect(storage.values.has(`campus-app-kit:${key}`)).toBe(false);
    expect(storage.values.get("concourse:language-preference")).toBe("de");
  });

  it("returns a recent cache entry for a transient network failure and marks it offline", async () => {
    const key = getPublicCacheKey("today");
    await setPersistedCache(key, { status: "cached" });
    expect([...storage.values.keys()]).toContain(`${CACHE_STORAGE_NAMESPACE}${key}`);

    const result = await fetchNetworkFirstWithFallback(
      key,
      async () => Promise.reject(new TypeError("network unavailable")),
      (value): value is { status: string } => typeof value === "object" && value !== null && "status" in value
    );

    expect(result).toMatchObject({
      data: { status: "cached" },
      fromCache: true,
      isOffline: true
    });
    expect(result.cacheAge).toBeTypeOf("number");
    await expect(isOfflineData(key)).resolves.toBe(true);
  });

  it("uses one stable public cache key for equivalent query objects", () => {
    expect(getPublicCacheKey("rooms", { search: "library", campus: "main" }))
      .toBe(getPublicCacheKey("rooms", { campus: "main", search: "library" }));
    expect(getPublicCacheKey("rooms", { campus: "main", search: "library" }))
      .toBe("public:v1:https://api.example.test:mockuni:rooms?campus=main&search=library");
  });

  it("keeps static demo filters deterministic and falls back to the current campus date", () => {
    const response = getStaticDemoResponse("/events", { date: "not-a-date", search: "library" });
    const fallback = getStaticDemoResponse("/events", undefined);
    if (!("events" in response) || !("events" in fallback)) {
      throw new Error("Events fixture contract changed");
    }

    expect(response).toMatchObject({ _total: 1, _sourcesConfigured: true });
    expect(response.events[0]).toMatchObject({ id: "library-tour", title: "Library introduction" });
    expect(response.events[0]?.date).toBe(fallback.events[1]?.date);
  });

  it("lists static demo events from the current campus day when no date is requested", () => {
    vi.useFakeTimers();
    try {
      // 23:30 UTC on 4 October is already 5 October on a Berlin campus.
      vi.setSystemTime(new Date("2026-10-04T23:30:00.000Z"));
      const response = getStaticDemoResponse("/events", undefined);
      if (!("events" in response)) throw new Error("Events fixture contract changed");
      expect(response.events.map((event) => event.date.slice(0, 10))).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears memory, snapshots, and selected-detail handoff in one operation", async () => {
    const demo = getStaticDemoResponse("/events", undefined);
    if (!("events" in demo) || !demo.events[0]) throw new Error("Events fixture contract changed");
    selectedEventDetails.remember(demo.events[0]);
    const persistedKey = getPublicCacheKey("clear-test");
    const legacyKey = getPublicCacheKey("legacy-clear-test");
    await setPersistedCache(persistedKey, { status: "saved" });
    storage.values.set(`campus-app-kit:${legacyKey}`, JSON.stringify({
      data: { status: "legacy" },
      timestamp: Date.now(),
    }));
    await getCached("clear-test", async () => 1, 60_000);

    await clearPublicDataState();

    expect(selectedEventDetails.get(demo.events[0].id)).toBeNull();
    expect(storage.values.has(`${CACHE_STORAGE_NAMESPACE}${persistedKey}`)).toBe(false);
    expect(storage.values.has(`campus-app-kit:${legacyKey}`)).toBe(false);
    await expect(getCached("clear-test", async () => 2, 60_000)).resolves.toBe(2);
  });

  it("preserves rendered information, stops its spinner, and does not start a replacement load on clear", async () => {
    const rendered = { title: "Already visible" };
    let loading = true;
    const replacement = vi.fn();
    const unsubscribe = subscribePublicDataClear(() => { loading = false; });

    await clearPublicDataState();

    expect(rendered).toEqual({ title: "Already visible" });
    expect(loading).toBe(false);
    expect(replacement).not.toHaveBeenCalled();
    unsubscribe();
  });
});
