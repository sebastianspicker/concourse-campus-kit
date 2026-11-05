/** Provides a bounded TTL cache with deduplicated in-flight loads. */

import { log } from "../../runtime/logger";

type CacheEntry<T> = { value: T; expiresAt: number; lastAccessedAt: number };
type InFlightEntry = { promise: Promise<unknown>; controller: AbortController };
export type CacheLoader<T> = (signal: AbortSignal) => Promise<T>;
export type CacheStats = { readonly size: number; readonly hits: number; readonly misses: number; readonly evictions: number };

const cache = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, InFlightEntry>();
const DEFAULT_IN_FLIGHT_TIMEOUT_MS = 25_000;
const MAX_CACHE_ENTRIES = 1000;
const MAX_IN_FLIGHT = 500;
const CLEANUP_INTERVAL_MS = 60_000;
let hits = 0;
let misses = 0;
let evictions = 0;

function sweepExpiredEntries(): void {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
      evictions += 1;
    }
  }
  if (inFlight.size > 200) log("warn", "cache_inflight_potentially_leaked", { count: inFlight.size });
}

let sweepInterval: ReturnType<typeof setInterval> | null = setInterval(sweepExpiredEntries, CLEANUP_INTERVAL_MS);
if (sweepInterval && typeof sweepInterval.unref === "function") sweepInterval.unref();

function evictIfOverCap(): void {
  while (cache.size > MAX_CACHE_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestAccess = Infinity;
    for (const [key, entry] of cache.entries()) {
      if (entry.expiresAt <= Date.now()) {
        oldestKey = key;
        break;
      }
      if (entry.lastAccessedAt < oldestAccess) {
        oldestAccess = entry.lastAccessedAt;
        oldestKey = key;
      }
    }
    if (!oldestKey) return;
    cache.delete(oldestKey);
    evictions += 1;
  }
}

function getCachedEntry<T>(key: string, force: boolean | undefined): CacheEntry<T> | undefined {
  if (force) {
    cache.delete(key);
    return undefined;
  }

  const entry = cache.get(key) as CacheEntry<T> | undefined;
  const now = Date.now();
  if (entry?.expiresAt && entry.expiresAt > now) {
    hits += 1;
    cache.set(key, { ...entry, lastAccessedAt: now });
    return entry;
  }
  if (entry) cache.delete(key);
  return undefined;
}

function getAdmittedInFlight<T>(key: string): Promise<T> | undefined {
  const existing = inFlight.get(key);
  if (existing) return existing.promise as Promise<T>;
  if (inFlight.size >= MAX_IN_FLIGHT) {
    log("error", "cache_inflight_limit_reached", { count: inFlight.size, key });
    throw new Error("Server busy: too many concurrent data requests");
  }
  return undefined;
}

async function loadAndStore<T>(key: string, loader: CacheLoader<T>, controller: AbortController, ttlFor: (value: T) => number): Promise<T> {
  const value = await loader(controller.signal);
  const valueTtlMs = ttlFor(value);
  if (!controller.signal.aborted && valueTtlMs > 0) {
    const storedAt = Date.now();
    cache.set(key, { value, expiresAt: storedAt + valueTtlMs, lastAccessedAt: storedAt });
    evictIfOverCap();
  }
  return value;
}

/** Aborts and rejects an in-flight loader once its deadline passes. */
function withInFlightTimeout<T>(work: Promise<T>, controller: AbortController, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = () => finish(() => reject(
      controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new DOMException("The operation was aborted", "AbortError")
    ));
    const timer = setTimeout(() => controller.abort(new Error("Cache loader timeout")), timeoutMs);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    );
    if (controller.signal.aborted) onAbort();
  });
}

/** Keeps timed-out loaders admitted until the underlying operation settles. */
function releaseInFlightWhenSettled(key: string, entry: InFlightEntry, work: Promise<unknown>): void {
  void work.then(
    () => {
      if (inFlight.get(key) === entry) inFlight.delete(key);
    },
    () => {
      if (inFlight.get(key) === entry) inFlight.delete(key);
    }
  );
}

const DEGRADED_TTL_MS = 60_000;

/** Keeps partial results briefly so a failing upstream is not hit on every request. */
export function ttlUnlessDegraded(ttlMs: number): (result: { degraded: boolean }) => number {
  return (result) => (result.degraded ? Math.min(ttlMs, DEGRADED_TTL_MS) : ttlMs);
}

/**
 * Returns a cached value or shares one in-flight load; `ttlFor` may shorten a
 * value's lifetime (0 stores nothing) without changing the returned result.
 */
export async function getCached<T>(key: string, loader: CacheLoader<T>, ttlMs: number, options?: { inFlightTimeoutMs?: number; force?: boolean; ttlFor?: (value: T) => number }): Promise<T> {
  const cached = getCachedEntry<T>(key, options?.force);
  if (cached) return cached.value;

  misses += 1;
  const existing = getAdmittedInFlight<T>(key);
  if (existing) return existing;

  const controller = new AbortController();
  const timeoutMs = options?.inFlightTimeoutMs ?? DEFAULT_IN_FLIGHT_TIMEOUT_MS;
  const ttlFor = options?.ttlFor ?? (() => ttlMs);
  const entry: InFlightEntry = { controller, promise: Promise.resolve() };
  const work = loadAndStore(key, loader, controller, ttlFor);
  entry.promise = withInFlightTimeout(work, controller, timeoutMs);
  inFlight.set(key, entry);
  releaseInFlightWhenSettled(key, entry, work);

  return entry.promise as Promise<T>;
}

export function clearCache(key?: string): void {
  if (key) {
    cache.delete(key);
    inFlight.get(key)?.controller.abort();
    inFlight.delete(key);
    return;
  }
  cache.clear();
  for (const entry of inFlight.values()) entry.controller.abort();
  inFlight.clear();
  hits = 0;
  misses = 0;
  evictions = 0;
}

export function cacheStats(): CacheStats {
  return { size: cache.size, hits, misses, evictions };
}

export function destroyCache(): void {
  if (sweepInterval !== null) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
  clearCache();
}
