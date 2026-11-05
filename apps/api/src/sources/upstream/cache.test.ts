import { afterEach, describe, expect, it, vi } from "vitest";

import { cacheStats, clearCache, destroyCache, getCached, ttlUnlessDegraded } from "./cache";

afterEach(() => {
  clearCache();
  vi.useRealTimers();
});

describe("getCached", () => {
  it("serves a value only until its TTL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const loader = vi.fn(async () => "fresh");

    await expect(getCached("ttl", loader, 1_000)).resolves.toBe("fresh");
    vi.advanceTimersByTime(999);
    await expect(getCached("ttl", loader, 1_000)).resolves.toBe("fresh");
    vi.advanceTimersByTime(1);
    await expect(getCached("ttl", loader, 1_000)).resolves.toBe("fresh");

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent loads for the same key", async () => {
    let resolveLoad: ((value: string) => void) | undefined;
    const loader = vi.fn(() => new Promise<string>((resolve) => { resolveLoad = resolve; }));

    const first = getCached("shared", loader, 1_000);
    const second = getCached("shared", loader, 1_000);
    resolveLoad?.("shared value");

    await expect(Promise.all([first, second])).resolves.toEqual(["shared value", "shared value"]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("aborts an admitted loader when its key is cleared", async () => {
    let observedSignal: AbortSignal | undefined;
    const loader = vi.fn((signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
      observedSignal = signal;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));

    const pending = getCached("cancelled", loader, 1_000);
    clearCache("cancelled");

    expect(observedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toBeDefined();
    await expect(getCached("cancelled", async () => "replacement", 1_000)).resolves.toBe("replacement");
  });

  it("keeps the cache at its fixed capacity and evicts the least recently used entry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    for (let index = 0; index < 1_000; index += 1) {
      await getCached(`capacity-${index}`, async () => index, 60_000);
      vi.advanceTimersByTime(1);
    }
    await getCached("capacity-1000", async () => 1_000, 60_000);

    expect(cacheStats()).toMatchObject({ size: 1_000, evictions: 1 });
    const oldestLoader = vi.fn(async () => -1);
    await expect(getCached("capacity-0", oldestLoader, 60_000)).resolves.toBe(-1);
    expect(oldestLoader).toHaveBeenCalledOnce();
  });

  it("keeps degraded values for 60 seconds and healthy values for the full TTL", async () => {
    vi.useFakeTimers();
    const ttlFor = ttlUnlessDegraded(300_000);
    const degraded = vi.fn(async () => ({ degraded: true }));
    const healthy = vi.fn(async () => ({ degraded: false }));

    await getCached("degraded", degraded, 300_000, { ttlFor });
    await getCached("healthy", healthy, 300_000, { ttlFor });
    vi.advanceTimersByTime(59_999);
    await getCached("degraded", degraded, 300_000, { ttlFor });
    await getCached("healthy", healthy, 300_000, { ttlFor });
    expect(degraded).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await getCached("degraded", degraded, 300_000, { ttlFor });
    await getCached("healthy", healthy, 300_000, { ttlFor });
    expect(degraded).toHaveBeenCalledTimes(2);
    expect(healthy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(240_000);
    await getCached("healthy", healthy, 300_000, { ttlFor });
    expect(healthy).toHaveBeenCalledTimes(2);
  });

  it("never lets the degraded TTL exceed a shorter normal TTL", async () => {
    vi.useFakeTimers();
    const loader = vi.fn(async () => ({ degraded: true }));
    const ttlFor = ttlUnlessDegraded(1_000);
    await getCached("short", loader, 1_000, { ttlFor });
    vi.advanceTimersByTime(1_000);
    await getCached("short", loader, 1_000, { ttlFor });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("stores nothing when ttlFor returns 0", async () => {
    const loader = vi.fn(async () => "value");
    await getCached("zero", loader, 1_000, { ttlFor: () => 0 });
    await getCached("zero", loader, 1_000, { ttlFor: () => 0 });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("destroys pending cache work without retaining its timeout", async () => {
    vi.useFakeTimers();
    const pending = getCached("never-settles", async () => new Promise<string>(() => undefined), 1_000);

    destroyCache();

    await expect(pending).rejects.toHaveProperty("name", "AbortError");
    expect(vi.getTimerCount()).toBe(0);
  });
});
