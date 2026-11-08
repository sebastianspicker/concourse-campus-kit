/** "Clear saved data" must also clear the in-memory store used while native storage is unavailable (P-8). */
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

import { clearPersistedCache, getCacheStats, setPersistedCache } from "../persistedCache";
import { getPublicCacheKey } from "../publicCacheKey";

describe("clearing saved data without native storage", () => {
  it("empties the in-memory fallback even though it reports native storage as unavailable", async () => {
    storage.setUnavailable(true);
    await setPersistedCache(getPublicCacheKey("rooms"), { rooms: [] });
    expect((await getCacheStats()).keyCount).toBe(1);

    await expect(clearPersistedCache()).rejects.toThrow("Saved data storage is unavailable");

    expect((await getCacheStats()).keyCount).toBe(0);
  });
});
