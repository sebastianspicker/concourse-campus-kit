import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => {
  const values = new Map<string, string>();
  let getItemInterceptor: ((key: string) => Promise<string | null>) | null = null;
  let setItemInterceptor: ((key: string, value: string) => Promise<void>) | null = null;
  return {
    values,
    setGetItemInterceptor(interceptor: typeof getItemInterceptor) { getItemInterceptor = interceptor; },
    setSetItemInterceptor(interceptor: typeof setItemInterceptor) { setItemInterceptor = interceptor; },
    getItem: vi.fn(async (key: string) => getItemInterceptor ? getItemInterceptor(key) : values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      if (setItemInterceptor) return setItemInterceptor(key, value);
      values.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => { values.delete(key); }),
    getAllKeys: vi.fn(async () => [...values.keys()]),
    multiGet: vi.fn(async (keys: readonly string[]) => keys.map((key) => [key, values.get(key) ?? null] as const)),
    multiRemove: vi.fn(async (keys: readonly string[]) => { for (const key of keys) values.delete(key); }),
  };
});

vi.mock("@react-native-async-storage/async-storage", () => ({ default: storage }));
vi.mock("@/platform/env/env", () => ({ getBffBaseUrl: () => "https://api.example.test" }));
vi.mock("@/platform/env/institution", () => ({ getConfiguredInstitutionId: () => "example" }));

import {
  CACHE_STORAGE_NAMESPACE,
  MAX_PERSISTED_CACHE_BYTES,
  OFFLINE_CACHE_MAX_AGE_MS,
  clearPersistedCache,
  fetchNetworkFirstWithFallback,
  getCacheStats,
  setPersistedCache,
  subscribePersistedCacheMutations,
} from "../persistedCache";
import { getPublicCacheKey } from "../publicCacheKey";
import { ApiErrorException } from "@/platform/http/errors";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

beforeEach(async () => {
  storage.setGetItemInterceptor(null);
  storage.setSetItemInterceptor(null);
  await clearPersistedCache();
  storage.values.clear();
  vi.clearAllMocks();
});

afterEach(async () => {
  storage.setGetItemInterceptor(null);
  storage.setSetItemInterceptor(null);
  await clearPersistedCache();
  vi.useRealTimers();
});

describe("persisted public cache coordination", () => {
  it("starts network before storage and returns validated network data before a best-effort save", async () => {
    const key = getPublicCacheKey("events", { search: "open" });
    const storageRead = deferred<string | null>();
    const storageWrite = deferred<void>();
    storage.setGetItemInterceptor(async (requestedKey) => {
      if (requestedKey === `${CACHE_STORAGE_NAMESPACE}${key}`) return storageRead.promise;
      return storage.values.get(requestedKey) ?? null;
    });
    storage.setSetItemInterceptor(async (requestedKey, value) => {
      if (requestedKey === `${CACHE_STORAGE_NAMESPACE}${key}`) return storageWrite.promise;
      storage.values.set(requestedKey, value);
    });
    const loader = vi.fn(async () => ({ events: [] as unknown[] }));

    const result = fetchNetworkFirstWithFallback(key, loader);
    expect(loader).toHaveBeenCalledTimes(1);
    await expect(result).resolves.toMatchObject({ data: { events: [] }, fromCache: false });

    storageRead.resolve(null);
    storageWrite.resolve();
  });

  it("rejects validation errors without waiting for a slow persisted read", async () => {
    const key = getPublicCacheKey("events", { search: "invalid" });
    const storageRead = deferred<string | null>();
    storage.setGetItemInterceptor(async (requestedKey) => {
      if (requestedKey === `${CACHE_STORAGE_NAMESPACE}${key}`) return storageRead.promise;
      return storage.values.get(requestedKey) ?? null;
    });
    const validationError = new ApiErrorException({
      code: "validation_error",
      status: 502,
      message: "invalid response",
    });

    const result = fetchNetworkFirstWithFallback(key, async () => Promise.reject(validationError));
    await expect(result).rejects.toBe(validationError);
    storageRead.resolve(null);
  });

  it("discards an invalid read that completes after clear and cannot delete the new generation", async () => {
    const key = getPublicCacheKey("rooms");
    const storageKey = `${CACHE_STORAGE_NAMESPACE}${key}`;
    const oldRead = deferred<string | null>();
    let delayed = true;
    storage.setGetItemInterceptor(async (requestedKey) => {
      if (requestedKey === storageKey && delayed) {
        delayed = false;
        return oldRead.promise;
      }
      return storage.values.get(requestedKey) ?? null;
    });

    const staleRequest = fetchNetworkFirstWithFallback(key, async () => Promise.reject(new TypeError("offline")));
    await Promise.resolve();
    await clearPersistedCache();
    await setPersistedCache(key, { rooms: [{ id: "new" }] });
    oldRead.resolve("not-json");

    await expect(staleRequest).rejects.toBeInstanceOf(TypeError);
    await Promise.resolve();
    expect(JSON.parse(storage.values.get(storageKey) ?? "{}")).toMatchObject({
      data: { rooms: [{ id: "new" }] },
    });
  });

  it("serializes active and queued writes so clear is the final mutation", async () => {
    const firstKey = getPublicCacheKey("events", { search: "first" });
    const secondKey = getPublicCacheKey("events", { search: "second" });
    const firstWrite = deferred<void>();
    let blocked = false;
    storage.setSetItemInterceptor(async (key, value) => {
      if (key === `${CACHE_STORAGE_NAMESPACE}${firstKey}` && !blocked) {
        blocked = true;
        await firstWrite.promise;
      }
      storage.values.set(key, value);
    });

    const active = setPersistedCache(firstKey, { id: 1 });
    while (!blocked) await Promise.resolve();
    const queued = setPersistedCache(secondKey, { id: 2 });
    const clearing = clearPersistedCache();
    firstWrite.resolve();
    await Promise.all([active, queued, clearing]);

    expect([...storage.values.keys()].filter((key) => key.startsWith("concourse:public:v"))).toEqual([]);
  });

  it("does not overwrite a same-millisecond newer value while marking a fallback offline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T10:00:00Z"));
    const key = getPublicCacheKey("today");
    const storageKey = `${CACHE_STORAGE_NAMESPACE}${key}`;
    await setPersistedCache(key, { version: "old" });
    const oldRaw = storage.values.get(storageKey)!;
    const observedRead = deferred<string | null>();
    let keyReads = 0;
    let observationBlocked = false;
    storage.setGetItemInterceptor(async (requestedKey) => {
      if (requestedKey !== storageKey) return storage.values.get(requestedKey) ?? null;
      keyReads += 1;
      if (keyReads === 3) {
        observationBlocked = true;
        return observedRead.promise;
      }
      return storage.values.get(requestedKey) ?? null;
    });

    const fallback = fetchNetworkFirstWithFallback(key, async () => Promise.reject(new TypeError("offline")));
    while (!observationBlocked) await Promise.resolve();
    await setPersistedCache(key, { version: "new" });
    observedRead.resolve(oldRaw);

    await expect(fallback).resolves.toMatchObject({ data: { version: "old" }, fromCache: true });
    const persisted = JSON.parse(storage.values.get(storageKey) ?? "{}");
    expect(persisted).toMatchObject({ data: { version: "new" } });
    expect(persisted.isOffline).toBeUndefined();
  });

  it("expires stale envelopes and preserves preferences and unrelated records", async () => {
    const key = getPublicCacheKey("today");
    storage.values.set(`${CACHE_STORAGE_NAMESPACE}${key}`, JSON.stringify({
      data: { stale: true },
      timestamp: Date.now() - OFFLINE_CACHE_MAX_AGE_MS - 1,
    }));
    storage.values.set("concourse:language-preference", "de");
    storage.values.set("unrelated", "keep");

    await expect(fetchNetworkFirstWithFallback(key, async () => Promise.reject(new TypeError("offline"))))
      .rejects.toBeInstanceOf(TypeError);
    await clearPersistedCache();

    expect(storage.values.get("concourse:language-preference")).toBe("de");
    expect(storage.values.get("unrelated")).toBe("keep");
  });

  it("does not advertise endpoint-invalid saved data and notifies when fallback validation removes it", async () => {
    const key = getPublicCacheKey("events");
    const storageKey = `${CACHE_STORAGE_NAMESPACE}${key}`;
    storage.values.set(storageKey, JSON.stringify({ data: { malformed: true }, timestamp: Date.now() }));
    await expect(getCacheStats()).resolves.toMatchObject({ keyCount: 0, offlineKeys: [] });
    let notifyRemoval!: () => void;
    const removed = new Promise<void>((resolve) => { notifyRemoval = resolve; });
    const unsubscribe = subscribePersistedCacheMutations(() => notifyRemoval());

    await expect(fetchNetworkFirstWithFallback(
      key,
      async () => Promise.reject(new TypeError("offline")),
      (value): value is { events: unknown[] } => typeof value === "object" && value !== null &&
        "events" in value && Array.isArray(value.events),
    )).rejects.toBeInstanceOf(TypeError);
    await removed;

    expect(storage.values.has(storageKey)).toBe(false);
    unsubscribe();
  });

  it("uses one discovered metadata index and evicts by timestamp then key at fifty entries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T10:00:00Z"));
    const keys = Array.from({ length: 52 }, (_, index) => getPublicCacheKey("events", {
      search: `entry-${String(index).padStart(2, "0")}`,
    }));
    for (const key of keys) await setPersistedCache(key, { events: [] });

    const stats = await getCacheStats();
    expect(stats.keyCount).toBe(50);
    expect(storage.getAllKeys).toHaveBeenCalledTimes(1);
    expect(storage.values.has(`${CACHE_STORAGE_NAMESPACE}${keys[0]}`)).toBe(false);
    expect(storage.values.has(`${CACHE_STORAGE_NAMESPACE}${keys[1]}`)).toBe(false);
    expect(storage.values.has(`${CACHE_STORAGE_NAMESPACE}${keys[51]}`)).toBe(true);
  });

  it("uses metadata-only stats after one batched discovery and later write notifications", async () => {
    const firstKey = getPublicCacheKey("events", { search: "discovered" });
    storage.values.set(`${CACHE_STORAGE_NAMESPACE}${firstKey}`, JSON.stringify({
      data: { events: [] },
      timestamp: Date.now(),
    }));
    await expect(getCacheStats()).resolves.toMatchObject({ keyCount: 1 });
    expect(storage.multiGet).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    const unsubscribe = subscribePersistedCacheMutations(() => { void getCacheStats(); });

    await setPersistedCache(getPublicCacheKey("rooms", { search: "new" }), { rooms: [] });
    await getCacheStats();
    await getCacheStats();

    expect(storage.getAllKeys).not.toHaveBeenCalled();
    expect(storage.multiGet).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("cleans expired, malformed, and oversized physical records during indexless discovery", async () => {
    const now = Date.now();
    const expiredKey = getPublicCacheKey("events", { search: "expired-upgrade" });
    const malformedKey = getPublicCacheKey("events", { search: "malformed-upgrade" });
    const oversizedKey = getPublicCacheKey("events", { search: "oversized-upgrade" });
    storage.values.set(`${CACHE_STORAGE_NAMESPACE}${expiredKey}`, JSON.stringify({
      data: { events: [] },
      timestamp: now - OFFLINE_CACHE_MAX_AGE_MS - 1,
    }));
    storage.values.set(`${CACHE_STORAGE_NAMESPACE}${malformedKey}`, "not-json");
    storage.values.set(`${CACHE_STORAGE_NAMESPACE}${oversizedKey}`, JSON.stringify({
      data: { events: [], padding: "z".repeat(1024 * 1024) },
      timestamp: now,
    }));
    for (let index = 0; index < 51; index += 1) {
      const key = getPublicCacheKey("rooms", { search: `upgrade-${String(index).padStart(2, "0")}` });
      storage.values.set(`${CACHE_STORAGE_NAMESPACE}${key}`, JSON.stringify({ data: { rooms: [], _total: index }, timestamp: now }));
    }
    storage.values.set("concourse:language-preference", "en");

    await setPersistedCache(getPublicCacheKey("today"), { events: [], rooms: [] });

    const physical = [...storage.values.entries()].filter(([key]) => key.startsWith("concourse:public:v"));
    expect(physical).toHaveLength(50);
    expect(physical.reduce((total, [, raw]) => total + new TextEncoder().encode(raw).byteLength, 0))
      .toBeLessThanOrEqual(MAX_PERSISTED_CACHE_BYTES);
    expect(storage.values.has(`${CACHE_STORAGE_NAMESPACE}${expiredKey}`)).toBe(false);
    expect(storage.values.has(`${CACHE_STORAGE_NAMESPACE}${malformedKey}`)).toBe(false);
    expect(storage.values.has(`${CACHE_STORAGE_NAMESPACE}${oversizedKey}`)).toBe(false);
    expect(storage.values.get("concourse:language-preference")).toBe("en");
  });

  it("keeps the total under four MiB and never persists a one-MiB envelope", async () => {
    const payload = "x".repeat(900 * 1024);
    for (let index = 0; index < 5; index += 1) {
      await setPersistedCache(getPublicCacheKey("schedule", { search: String(index) }), { payload });
    }
    const publicBytes = [...storage.values.entries()]
      .filter(([key]) => key.startsWith("concourse:public:v"))
      .reduce((total, [, raw]) => total + new TextEncoder().encode(raw).byteLength, 0);
    expect(publicBytes).toBeLessThanOrEqual(MAX_PERSISTED_CACHE_BYTES);

    const oversizedKey = getPublicCacheKey("events", { search: "oversized" });
    const oversized = { payload: "y".repeat(1024 * 1024) };
    await setPersistedCache(oversizedKey, { payload: "old" });
    let notifyRemoved!: () => void;
    const removed = new Promise<void>((resolve) => { notifyRemoved = resolve; });
    const unsubscribe = subscribePersistedCacheMutations((mutation) => {
      if (mutation === "write") notifyRemoved();
    });
    await expect(fetchNetworkFirstWithFallback(oversizedKey, async () => oversized)).resolves.toMatchObject({
      data: oversized,
      fromCache: false,
    });
    await removed;
    expect(storage.values.has(`${CACHE_STORAGE_NAMESPACE}${oversizedKey}`)).toBe(false);
    unsubscribe();
  });

  it("notifies valid writes, offline marking, and clear while tolerating save errors", async () => {
    const key = getPublicCacheKey("events");
    const mutations: string[] = [];
    const unsubscribe = subscribePersistedCacheMutations((mutation) => mutations.push(mutation));
    await setPersistedCache(key, { events: [] });
    await expect(fetchNetworkFirstWithFallback(key, async () => Promise.reject(new TypeError("offline"))))
      .resolves.toMatchObject({ fromCache: true, isOffline: true });
    await clearPersistedCache();
    expect(mutations).toEqual(["write", "offline", "clear"]);

    storage.setSetItemInterceptor(async () => { throw new Error("storage unavailable"); });
    await expect(fetchNetworkFirstWithFallback(key, async () => ({ events: [{ id: "online" }] })))
      .resolves.toMatchObject({ fromCache: false, data: { events: [{ id: "online" }] } });
    unsubscribe();
  });
});
