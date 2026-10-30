import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCache, getCached, getCachedWithMetadata } from "../cache";
import { replaceRequestController } from "../requestGuard";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

afterEach(() => clearCache());

describe("memory request coordination", () => {
  it("coalesces forced consumers while cancelling each consumer independently", async () => {
    const transport = deferred<number>();
    let sharedSignal: AbortSignal | undefined;
    const loader = vi.fn((signal: AbortSignal) => {
      sharedSignal = signal;
      return transport.promise;
    });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = getCached("same", loader, 60_000, false, firstController.signal);
    const second = getCached("same", loader, 60_000, true, secondController.signal);
    firstController.abort();

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(sharedSignal?.aborted).toBe(false);
    transport.resolve(42);
    await expect(second).resolves.toBe(42);
  });

  it("aborts transport with the last consumer and lets a later force start cleanly", async () => {
    const transports = [deferred<number>(), deferred<number>()];
    const signals: AbortSignal[] = [];
    const loader = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return transports[signals.length - 1]!.promise;
    });
    const controller = new AbortController();
    const cancelled = getCached("replace", loader, 60_000, false, controller.signal);

    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(signals[0]?.aborted).toBe(true);

    const replacement = getCached("replace", loader, 60_000, true);
    expect(loader).toHaveBeenCalledTimes(2);
    transports[1]!.resolve(9);
    await expect(replacement).resolves.toBe(9);
    transports[0]!.resolve(1);
  });

  it("preserves an explicit fresh memory path after a coordinated success", async () => {
    const loader = vi.fn(async () => "network-value");
    await expect(getCachedWithMetadata("memory", loader, 60_000)).resolves.toEqual({
      value: "network-value",
      fromCache: false,
    });
    await expect(getCachedWithMetadata("memory", loader, 60_000)).resolves.toEqual({
      value: "network-value",
      fromCache: true,
    });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("aborts coordinated transport when cache state is cleared", async () => {
    const transport = deferred<number>();
    let signal: AbortSignal | undefined;
    const request = getCached("clear", (sharedSignal) => {
      signal = sharedSignal;
      return transport.promise;
    }, 60_000);

    clearCache();
    expect(signal?.aborted).toBe(true);
    transport.resolve(1);
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("attaches replacement ownership before aborting the previous consumer", async () => {
    const transport = deferred<number>();
    let sharedSignal: AbortSignal | undefined;
    const loader = vi.fn((signal: AbortSignal) => {
      sharedSignal = signal;
      return transport.promise;
    });
    const originalController = new AbortController();
    const controllerRef: { current: AbortController | null } = { current: originalController };
    const original = getCached("refresh", loader, 60_000, true, originalController.signal);

    const replacement = replaceRequestController(
      controllerRef,
      (signal) => getCached("refresh", loader, 60_000, true, signal),
    );

    await expect(original).rejects.toMatchObject({ name: "AbortError" });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(sharedSignal?.aborted).toBe(false);
    transport.resolve(7);
    await expect(replacement.load).resolves.toBe(7);
  });
});
