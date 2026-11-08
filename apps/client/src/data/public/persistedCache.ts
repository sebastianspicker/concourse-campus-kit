/** Persists validated public data and implements network-first offline fallback semantics. */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { isTransientPublicDataFailure } from "@/platform/http/errors";
import type { StorageValueReader } from "@/platform/storage/readAndMigrateLegacyValue";
import {
  EventsResponseSchema,
  RoomsResponseSchema,
  ScheduleResponseSchema,
  TodayResponseSchema,
} from "@concourse/contracts";

type StorageLike = StorageValueReader & {
  getAllKeys?: () => Promise<readonly string[]>;
  multiGet?: (keys: readonly string[]) => Promise<readonly (readonly [string, string | null])[]>;
  multiRemove?: (keys: readonly string[]) => Promise<void>;
};

export const CACHE_STORAGE_NAMESPACE = "concourse:";
export const LEGACY_CACHE_STORAGE_NAMESPACE = "campus-app-kit:";
const CACHE_INDEX_STORAGE_KEY = "concourse:public-cache-index:v1";
const CURRENT_PUBLIC_PREFIX = `${CACHE_STORAGE_NAMESPACE}public:v`;
const LEGACY_PUBLIC_PREFIX = `${LEGACY_CACHE_STORAGE_NAMESPACE}public:v`;
const PUBLIC_LOGICAL_KEY_PATTERN = /^public:v\d+:/;
const memory = new Map<string, string>();
const memoryStorage: StorageLike = {
  getItem: async (key) => memory.get(key) ?? null,
  setItem: async (key, value) => { memory.set(key, value); },
  removeItem: async (key) => { memory.delete(key); },
  getAllKeys: async () => [...memory.keys()],
  multiGet: async (keys) => keys.map((key) => [key, memory.get(key) ?? null] as const),
  multiRemove: async (keys) => { for (const key of keys) memory.delete(key); },
};

export const OFFLINE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_PERSISTED_CACHE_ENTRIES = 50;
export const MAX_PERSISTED_CACHE_BYTES = 4 * 1024 * 1024;
export const MAX_PERSISTED_ENTRY_BYTES = 1024 * 1024;

export type CachedEntry<T> = {
  data: T;
  timestamp: number;
  isOffline?: boolean;
};

type CacheValidator<T> = (value: unknown) => value is T;
type RawCacheEntry<T> = { raw: string; entry: CachedEntry<T> };
type CacheIndexEntry = { timestamp: number; bytes: number; isValid: boolean; isOffline?: boolean };
type CacheIndex = { entries: Record<string, CacheIndexEntry> };
export type PersistedCacheMutation = "write" | "offline" | "migration" | "clear";

const mutationListeners = new Set<(mutation: PersistedCacheMutation) => void>();
let publicDataGeneration = 0;
let mutationTail: Promise<void> = Promise.resolve();
let nativeStorageState: StorageLike | null | undefined;
let nativeStorageProbe: Promise<StorageLike | null> | null = null;
const indexByStorage = new WeakMap<object, Promise<CacheIndex>>();

const CACHE_ENTRY_ENVELOPE_SCHEMA = z.object({
  data: z.unknown(),
  timestamp: z.number().finite().nonnegative(),
  isOffline: z.boolean().optional(),
}).refine((entry) => Object.hasOwn(entry, "data"), { message: "Cache entry data is required" })
  .refine((entry) => entry.timestamp <= Date.now() + 5 * 60 * 1000, { message: "Cache entry timestamp is in the future" });

function notifyMutation(mutation: PersistedCacheMutation): void {
  for (const listener of mutationListeners) listener(mutation);
}

export function subscribePersistedCacheMutations(
  listener: (mutation: PersistedCacheMutation) => void,
): () => void {
  mutationListeners.add(listener);
  return () => mutationListeners.delete(listener);
}

function createMemoryStorage(): StorageLike {
  return memoryStorage;
}

function isStorageAdapter(value: unknown): value is StorageLike {
  return typeof value === "object" && value !== null && "getItem" in value &&
    typeof value.getItem === "function";
}

async function probeNativeStorage(): Promise<StorageLike | null> {
  if (!isStorageAdapter(AsyncStorage)) return null;
  try {
    await AsyncStorage.getItem(`${CACHE_STORAGE_NAMESPACE}__probe__`);
    return AsyncStorage as StorageLike;
  } catch {
    return null;
  }
}

/** Retries a previously unavailable native adapter at the next foreground boundary. */
export function retryNativeStorageOnForeground(): void {
  if (nativeStorageState === null) nativeStorageState = undefined;
}

async function getStorage(): Promise<StorageLike> {
  if (nativeStorageState !== undefined) return nativeStorageState ?? createMemoryStorage();
  nativeStorageProbe ??= probeNativeStorage();
  nativeStorageState = await nativeStorageProbe;
  nativeStorageProbe = null;
  return nativeStorageState ?? createMemoryStorage();
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isVersionedPublicLogicalKey(key: string): boolean {
  return PUBLIC_LOGICAL_KEY_PATTERN.test(key);
}

function isVersionedPublicStorageKey(key: string): boolean {
  return (key.startsWith(CURRENT_PUBLIC_PREFIX) || key.startsWith(LEGACY_PUBLIC_PREFIX)) &&
    PUBLIC_LOGICAL_KEY_PATTERN.test(key.slice(key.indexOf("public:v")));
}

function logicalKeyFromStorageKey(key: string): string | null {
  if (key.startsWith(CACHE_STORAGE_NAMESPACE)) return key.slice(CACHE_STORAGE_NAMESPACE.length);
  if (key.startsWith(LEGACY_CACHE_STORAGE_NAMESPACE)) return key.slice(LEGACY_CACHE_STORAGE_NAMESPACE.length);
  return null;
}

function isPayloadValidForStorageKey(storageKey: string, data: unknown): boolean {
  const logicalKey = logicalKeyFromStorageKey(storageKey);
  const endpoint = logicalKey?.match(/:(events|rooms|today|schedule)(?:\?|$)/)?.[1];
  if (endpoint === "events") return EventsResponseSchema.safeParse(data).success;
  if (endpoint === "rooms") return RoomsResponseSchema.safeParse(data).success;
  if (endpoint === "today") return TodayResponseSchema.safeParse(data).success;
  if (endpoint === "schedule") return ScheduleResponseSchema.safeParse(data).success;
  return false;
}

function isCacheEntry<T>(value: unknown, validator?: CacheValidator<T>): value is CachedEntry<T> {
  const envelope = CACHE_ENTRY_ENVELOPE_SCHEMA.safeParse(value);
  if (!envelope.success) return false;
  return validator ? validator(envelope.data.data) : true;
}

function parseCacheEntry<T>(raw: string, validator?: CacheValidator<T>): CachedEntry<T> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isCacheEntry<T>(parsed, validator) ? parsed : null;
  } catch {
    return null;
  }
}

function isFreshEntry(entry: CachedEntry<unknown>, now = Date.now()): boolean {
  return Math.max(0, now - entry.timestamp) <= OFFLINE_CACHE_MAX_AGE_MS;
}

async function batchRead(storage: StorageLike, keys: readonly string[]): Promise<Array<readonly [string, string | null]>> {
  if (keys.length === 0) return [];
  if (storage.multiGet) return [...await storage.multiGet(keys)];
  return Promise.all(keys.map(async (key) => [key, await storage.getItem(key)] as const));
}

async function discoverIndex(storage: StorageLike): Promise<CacheIndex> {
  const keys = (await storage.getAllKeys?.() ?? []).filter(isVersionedPublicStorageKey);
  const entries: Record<string, CacheIndexEntry> = {};
  for (const [key, raw] of await batchRead(storage, keys)) {
    if (!raw) continue;
    const bytes = byteLength(raw);
    const entry = parseCacheEntry<unknown>(raw);
    if (!entry || !isPayloadValidForStorageKey(key, entry.data)) {
      entries[key] = { timestamp: 0, bytes, isValid: false };
      continue;
    }
    entries[key] = {
      timestamp: entry.timestamp,
      bytes,
      isValid: true,
      ...(entry.isOffline === true ? { isOffline: true } : {}),
    };
  }
  return { entries };
}

async function loadIndex(storage: StorageLike): Promise<CacheIndex> {
  const existing = indexByStorage.get(storage as object);
  if (existing) return existing;
  // The persisted index is only a compatibility/diagnostics artifact. Rebuild
  // once per adapter so older metadata cannot advertise schema-invalid data.
  const loading = discoverIndex(storage);
  indexByStorage.set(storage as object, loading);
  try {
    return await loading;
  } catch (error: unknown) {
    if (indexByStorage.get(storage as object) === loading) indexByStorage.delete(storage as object);
    throw error;
  }
}

async function removeMany(storage: StorageLike, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  if (storage.multiRemove) await storage.multiRemove(keys);
  else await Promise.all(keys.map((key) => storage.removeItem(key)));
}

function selectEvictions(index: CacheIndex, now = Date.now()): string[] {
  const ordered = Object.entries(index.entries).sort(([keyA, a], [keyB, b]) =>
    a.timestamp - b.timestamp || (keyA < keyB ? -1 : keyA > keyB ? 1 : 0));
  const expired = ordered.filter(([, entry]) =>
    now - entry.timestamp > OFFLINE_CACHE_MAX_AGE_MS || entry.bytes > MAX_PERSISTED_ENTRY_BYTES);
  const survivors = ordered.filter(([, entry]) =>
    now - entry.timestamp <= OFFLINE_CACHE_MAX_AGE_MS && entry.bytes <= MAX_PERSISTED_ENTRY_BYTES);
  const evictions = expired.map(([key]) => key);
  let count = survivors.length;
  let bytes = survivors.reduce((total, [, entry]) => total + entry.bytes, 0);
  for (const [key, entry] of survivors) {
    if (count <= MAX_PERSISTED_CACHE_ENTRIES && bytes <= MAX_PERSISTED_CACHE_BYTES) break;
    evictions.push(key);
    count -= 1;
    bytes -= entry.bytes;
  }
  return evictions;
}

async function persistIndexAndEvict(storage: StorageLike, index: CacheIndex): Promise<void> {
  const evictions = selectEvictions(index);
  await removeMany(storage, evictions);
  for (const key of evictions) delete index.entries[key];
  await storage.setItem(CACHE_INDEX_STORAGE_KEY, JSON.stringify(index));
}

function enqueueMutation<T>(expectedGeneration: number, operation: () => Promise<T>): Promise<T | undefined> {
  const run = mutationTail.then(async () => {
    if (expectedGeneration !== publicDataGeneration) return undefined;
    return operation();
  });
  mutationTail = run.then(() => undefined, () => undefined);
  return run;
}

function enqueueClear(operation: () => Promise<void>): Promise<void> {
  const run = mutationTail.then(operation);
  mutationTail = run.then(() => undefined, () => undefined);
  return run;
}

async function removeIndexedEntry(storage: StorageLike, storageKey: string, observedRaw?: string): Promise<void> {
  if (observedRaw !== undefined && await storage.getItem(storageKey) !== observedRaw) return;
  await storage.removeItem(storageKey);
  const index = await loadIndex(storage);
  delete index.entries[storageKey];
  await storage.setItem(CACHE_INDEX_STORAGE_KEY, JSON.stringify(index));
  notifyMutation("write");
}

async function readRawCacheEntry<T>(
  storage: StorageLike,
  storageKey: string,
  validator: CacheValidator<T> | undefined,
  expectedGeneration: number,
): Promise<RawCacheEntry<T> | null> {
  const raw = await storage.getItem(storageKey);
  if (raw === null) return null;
  const entry = byteLength(raw) <= MAX_PERSISTED_ENTRY_BYTES ? parseCacheEntry<T>(raw, validator) : null;
  if (entry && isFreshEntry(entry)) return { raw, entry };
  void enqueueMutation(expectedGeneration, () => removeIndexedEntry(storage, storageKey, raw)).catch(() => undefined);
  return null;
}

async function getPersistedCacheRecord<T>(
  key: string,
  validator?: CacheValidator<T>,
  expectedGeneration = publicDataGeneration,
): Promise<RawCacheEntry<T> | null> {
  if (!isVersionedPublicLogicalKey(key)) return null;
  const storage = await getStorage();
  const currentStorageKey = CACHE_STORAGE_NAMESPACE + key;
  const currentEntry = await readRawCacheEntry<T>(storage, currentStorageKey, validator, expectedGeneration);
  if (expectedGeneration !== publicDataGeneration) return null;
  if (currentEntry) return currentEntry;

  const legacyStorageKey = LEGACY_CACHE_STORAGE_NAMESPACE + key;
  const legacyEntry = await readRawCacheEntry<T>(storage, legacyStorageKey, validator, expectedGeneration);
  if (!legacyEntry || expectedGeneration !== publicDataGeneration) return null;

  await enqueueMutation(expectedGeneration, async () => {
    const index = await loadIndex(storage);
    if (await storage.getItem(currentStorageKey) !== null || await storage.getItem(legacyStorageKey) !== legacyEntry.raw) return;
    await storage.setItem(currentStorageKey, legacyEntry.raw);
    await storage.removeItem(legacyStorageKey);
    delete index.entries[legacyStorageKey];
    index.entries[currentStorageKey] = {
      timestamp: legacyEntry.entry.timestamp,
      bytes: byteLength(legacyEntry.raw),
      isValid: isPayloadValidForStorageKey(currentStorageKey, legacyEntry.entry.data),
      ...(legacyEntry.entry.isOffline === true ? { isOffline: true } : {}),
    };
    await persistIndexAndEvict(storage, index);
    notifyMutation("migration");
  }).catch(() => undefined);
  return expectedGeneration === publicDataGeneration ? legacyEntry : null;
}

async function getPersistedCacheEntry<T>(
  key: string,
  validator?: CacheValidator<T>,
  expectedGeneration = publicDataGeneration,
): Promise<CachedEntry<T> | null> {
  return (await getPersistedCacheRecord(key, validator, expectedGeneration))?.entry ?? null;
}

async function setPersistedCacheAtGeneration<T>(key: string, value: T, expectedGeneration: number): Promise<void> {
  if (!isVersionedPublicLogicalKey(key)) return;
  const entry: CachedEntry<T> = { data: value, timestamp: Date.now() };
  const raw = JSON.stringify(entry);
  const bytes = byteLength(raw);
  if (bytes > MAX_PERSISTED_ENTRY_BYTES) {
    await enqueueMutation(expectedGeneration, async () => {
      const storage = await getStorage();
      await removeMany(storage, [CACHE_STORAGE_NAMESPACE + key, LEGACY_CACHE_STORAGE_NAMESPACE + key]);
      const index = await loadIndex(storage);
      delete index.entries[CACHE_STORAGE_NAMESPACE + key];
      delete index.entries[LEGACY_CACHE_STORAGE_NAMESPACE + key];
      await storage.setItem(CACHE_INDEX_STORAGE_KEY, JSON.stringify(index));
      notifyMutation("write");
    });
    return;
  }

  await enqueueMutation(expectedGeneration, async () => {
    const storage = await getStorage();
    const storageKey = CACHE_STORAGE_NAMESPACE + key;
    const index = await loadIndex(storage);
    await storage.setItem(storageKey, raw);
    index.entries[storageKey] = {
      timestamp: entry.timestamp,
      bytes,
      isValid: isPayloadValidForStorageKey(storageKey, value),
    };
    await persistIndexAndEvict(storage, index);
    notifyMutation("write");
  });
}

/** Persists a public value, retaining the generation active when the write was requested. */
export async function setPersistedCache<T>(key: string, value: T): Promise<void> {
  await setPersistedCacheAtGeneration(key, value, publicDataGeneration);
}

async function markCacheAsOfflineAtGeneration<T>(key: string, expectedGeneration: number): Promise<void> {
  const record = await getPersistedCacheRecord<T>(key, undefined, expectedGeneration);
  if (!record || expectedGeneration !== publicDataGeneration) return;
  const storage = await getStorage();
  const storageKey = CACHE_STORAGE_NAMESPACE + key;
  const observedRaw = await storage.getItem(storageKey);
  if (observedRaw !== record.raw) return;

  await enqueueMutation(expectedGeneration, async () => {
    const currentRaw = await storage.getItem(storageKey);
    if (currentRaw !== observedRaw) return;
    const current = parseCacheEntry<T>(currentRaw ?? "");
    if (!current) return;
    const offlineEntry: CachedEntry<T> = { ...current, isOffline: true };
    const raw = JSON.stringify(offlineEntry);
    const bytes = byteLength(raw);
    if (bytes > MAX_PERSISTED_ENTRY_BYTES) return;
    const index = await loadIndex(storage);
    await storage.setItem(storageKey, raw);
    index.entries[storageKey] = {
      timestamp: current.timestamp,
      bytes,
      isValid: isPayloadValidForStorageKey(storageKey, current.data),
      isOffline: true,
    };
    await persistIndexAndEvict(storage, index);
    notifyMutation("offline");
  });
}


/** Clears only versioned public cache records and invalidates every older queued mutation. */
export function clearPersistedCache(key?: string): Promise<void> {
  publicDataGeneration += 1;
  return enqueueClear(async () => {
    const storage = await getStorage();
    // Clear the store in use (the in-memory fallback included), then still report that disk data could not be reached.
    await clearPublicKeys(storage, key);
    if (nativeStorageState === null && isStorageAdapter(AsyncStorage)) {
      throw new Error("Saved data storage is unavailable");
    }
  });
}

async function clearPublicKeys(storage: StorageLike, key: string | undefined): Promise<void> {
  if (key !== undefined && !isVersionedPublicLogicalKey(key)) return;
  const keys = key !== undefined
    ? [CACHE_STORAGE_NAMESPACE + key, LEGACY_CACHE_STORAGE_NAMESPACE + key]
    : (await storage.getAllKeys?.() ?? []).filter(isVersionedPublicStorageKey);
  await removeMany(storage, keys);
  await storage.removeItem(CACHE_INDEX_STORAGE_KEY).catch(() => undefined);
  indexByStorage.delete(storage as object);
  notifyMutation("clear");
}

export type OfflineFetchResult<T> = {
  data: T;
  fromCache: boolean;
  isOffline: boolean;
  cacheAge: number | null;
};

const isDegraded = (value: unknown): boolean =>
  typeof value === "object" && value !== null && (value as { _degraded?: unknown })._degraded === true;

/** Keeps a complete saved copy (it ages out after 24 h) rather than replacing it with a partial, degraded one. */
async function persistUnlessDowngrade<T>(
  key: string,
  value: T,
  cached: Promise<CachedEntry<T> | null>,
  expectedGeneration: number,
): Promise<void> {
  if (isDegraded(value)) {
    const existing = await cached;
    if (existing && !isDegraded(existing.data)) return;
  }
  await setPersistedCacheAtGeneration(key, value, expectedGeneration);
}

/** Attempts network immediately, using one concurrently started persisted read after transient failure. */
export async function fetchNetworkFirstWithFallback<T>(
  key: string,
  loader: () => Promise<T>,
  validator?: CacheValidator<T>,
): Promise<OfflineFetchResult<T>> {
  const expectedGeneration = publicDataGeneration;
  let network: Promise<T>;
  try {
    network = loader();
  } catch (error: unknown) {
    network = Promise.reject(error);
  }
  const cached = getPersistedCacheEntry<T>(key, validator, expectedGeneration).catch(() => null);

  try {
    const freshData = await network;
    if (expectedGeneration === publicDataGeneration) {
      void persistUnlessDowngrade(key, freshData, cached, expectedGeneration).catch(() => undefined);
    }
    return { data: freshData, fromCache: false, isOffline: false, cacheAge: null };
  } catch (error: unknown) {
    if (!isTransientPublicDataFailure(error)) throw error;
    const cachedEntry = await cached;
    if (expectedGeneration !== publicDataGeneration) throw error;
    const fallback = await getTransientCacheFallback(key, cachedEntry, error, expectedGeneration);
    if (fallback) return fallback;
    throw error;
  }
}

async function getTransientCacheFallback<T>(
  key: string,
  cachedEntry: CachedEntry<T> | null,
  error: unknown,
  expectedGeneration: number,
): Promise<OfflineFetchResult<T> | null> {
  if (!cachedEntry || !isTransientPublicDataFailure(error)) return null;
  const cacheAge = Math.max(0, Date.now() - cachedEntry.timestamp);
  if (cacheAge > OFFLINE_CACHE_MAX_AGE_MS) return null;
  await markCacheAsOfflineAtGeneration<T>(key, expectedGeneration).catch(() => undefined);
  if (expectedGeneration !== publicDataGeneration) return null;
  return { data: cachedEntry.data, fromCache: true, isOffline: true, cacheAge };
}

export async function isOfflineData(key: string): Promise<boolean> {
  const entry = await getPersistedCacheEntry<unknown>(key);
  return entry?.isOffline ?? false;
}

export async function getCacheStats(): Promise<{
  keyCount: number;
  oldestEntry: number | null;
  newestEntry: number | null;
  offlineKeys: string[];
}> {
  const storage = await getStorage();
  const index = await loadIndex(storage);
  const logicalEntries = new Map<string, CacheIndexEntry>();
  for (const [storageKey, entry] of Object.entries(index.entries)) {
    if (!entry.isValid || !isVersionedPublicStorageKey(storageKey) ||
      Date.now() - entry.timestamp > OFFLINE_CACHE_MAX_AGE_MS) continue;
    const logicalKey = logicalKeyFromStorageKey(storageKey);
    if (logicalKey && (storageKey.startsWith(CACHE_STORAGE_NAMESPACE) || !logicalEntries.has(logicalKey))) {
      logicalEntries.set(logicalKey, entry);
    }
  }

  const timestamps = [...logicalEntries.values()].map((entry) => entry.timestamp);
  return {
    keyCount: logicalEntries.size,
    oldestEntry: timestamps.length > 0 ? Math.min(...timestamps) : null,
    newestEntry: timestamps.length > 0 ? Math.max(...timestamps) : null,
    offlineKeys: [...logicalEntries.entries()].filter(([, entry]) => entry.isOffline).map(([key]) => key).sort(),
  };
}
