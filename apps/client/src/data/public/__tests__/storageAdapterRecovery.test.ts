import { describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => {
  const values = new Map<string, string>();
  let unavailable = true;
  return {
    values,
    setUnavailable(value: boolean) { unavailable = value; },
    getItem: vi.fn(async (key: string) => {
      if (unavailable) throw new Error("native storage unavailable");
      return values.get(key) ?? null;
    }),
    setItem: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
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
  clearPersistedCache,
  getCacheStats,
  retryNativeStorageOnForeground,
  setPersistedCache,
} from "../persistedCache";
import { getPublicCacheKey } from "../publicCacheKey";

describe("native storage adapter recovery", () => {
  it("coalesces an unavailable probe and retries it on foreground", async () => {
    storage.setUnavailable(true);
    await Promise.all([getCacheStats(), getCacheStats(), getCacheStats()]);
    expect(storage.getItem).toHaveBeenCalledTimes(1);
    const key = getPublicCacheKey("rooms");
    storage.values.set(`${CACHE_STORAGE_NAMESPACE}${key}`, JSON.stringify({ data: { rooms: [] }, timestamp: Date.now() }));
    await expect(clearPersistedCache()).rejects.toThrow("Saved data storage is unavailable");
    expect(storage.values.has(`${CACHE_STORAGE_NAMESPACE}${key}`)).toBe(true);

    storage.setUnavailable(false);
    retryNativeStorageOnForeground();
    await clearPersistedCache();
    await setPersistedCache(key, { rooms: [] });

    expect(storage.getItem.mock.calls.filter(([requestedKey]) => requestedKey === "concourse:__probe__")).toHaveLength(2);
    expect(storage.values.has(`${CACHE_STORAGE_NAMESPACE}${key}`)).toBe(true);
  });
});
