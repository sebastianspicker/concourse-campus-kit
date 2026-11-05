import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCache, shareLoad } from "../cache";
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

describe("shared request coordination", () => {
  it("coalesces consumers while cancelling each consumer independently", async () => {
    const transport = deferred<number>();
    let sharedSignal: AbortSignal | undefined;
    const loader = vi.fn((signal: AbortSignal) => {
      sharedSignal = signal;
      return transport.promise;
    });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = shareLoad("same", loader, firstController.signal);
    const second = shareLoad("same", loader, secondController.signal);
    firstController.abort();

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(sharedSignal?.aborted).toBe(false);
    transport.resolve(42);
    await expect(second).resolves.toBe(42);
  });

  it("aborts transport with the last consumer and lets a later load start cleanly", async () => {
    const transports = [deferred<number>(), deferred<number>()];
    const signals: AbortSignal[] = [];
    const loader = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return transports[signals.length - 1]!.promise;
    });
    const controller = new AbortController();
    const cancelled = shareLoad("replace", loader, controller.signal);

    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(signals[0]?.aborted).toBe(true);

    const replacement = shareLoad("replace", loader);
    expect(loader).toHaveBeenCalledTimes(2);
    transports[1]!.resolve(9);
    await expect(replacement).resolves.toBe(9);
    transports[0]!.resolve(1);
  });

  it("aborts coordinated transport when cache state is cleared", async () => {
    const transport = deferred<number>();
    let signal: AbortSignal | undefined;
    const request = shareLoad("clear", (sharedSignal) => {
      signal = sharedSignal;
      return transport.promise;
    });

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
    const original = shareLoad("refresh", loader, originalController.signal);

    const replacement = replaceRequestController(
      controllerRef,
      (signal) => shareLoad("refresh", loader, signal),
    );

    await expect(original).rejects.toMatchObject({ name: "AbortError" });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(sharedSignal?.aborted).toBe(false);
    transport.resolve(7);
    await expect(replacement.load).resolves.toBe(7);
  });
});
