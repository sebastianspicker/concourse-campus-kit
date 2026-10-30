import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiErrorException, createAbortError, RequestTimeoutError } from "../errors";
import { getRetryDelayMs, parseRetryAfterSeconds, shouldRetry, sleep, withRetry } from "../retry";

function apiError(status: number, retryAfterInSeconds?: number): ApiErrorException {
  return new ApiErrorException({ code: "x", message: "m", status, retryAfterInSeconds });
}

function midRandom() {
  return vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(((bytes: Uint32Array) => {
    bytes[0] = 0x80000000;
    return bytes;
  }) as typeof crypto.getRandomValues);
}

describe("shouldRetry", () => {
  it("retries 429, 5xx and TypeError only", () => {
    expect(shouldRetry(apiError(429))).toBe(true);
    expect(shouldRetry(apiError(500))).toBe(true);
    expect(shouldRetry(apiError(599))).toBe(true);
    expect(shouldRetry(apiError(404))).toBe(false);
    expect(shouldRetry(apiError(400))).toBe(false);
    expect(shouldRetry(new TypeError("net"))).toBe(true);
  });

  it("does not retry aborts, timeouts or unknown values", () => {
    expect(shouldRetry(createAbortError())).toBe(false);
    expect(shouldRetry(new RequestTimeoutError())).toBe(false);
    expect(shouldRetry(new Error("x"))).toBe(false);
    expect(shouldRetry("x")).toBe(false);
    expect(shouldRetry(null)).toBe(false);
  });
});

describe("createAbortError", () => {
  it("creates a named AbortError", () => {
    const error = createAbortError();
    expect(error.name).toBe("AbortError");
    expect(error.message).toBe("Request aborted");
  });
});

describe("parseRetryAfterSeconds", () => {
  afterEach(() => vi.useRealTimers());

  it("returns undefined for missing or unparsable values", () => {
    expect(parseRetryAfterSeconds(null)).toBeUndefined();
    expect(parseRetryAfterSeconds("")).toBeUndefined();
    expect(parseRetryAfterSeconds("soon")).toBeUndefined();
  });

  it("parses delay seconds and clamps negatives", () => {
    expect(parseRetryAfterSeconds("30")).toBe(30);
    expect(parseRetryAfterSeconds("0")).toBe(0);
    expect(parseRetryAfterSeconds("-5")).toBe(0);
  });

  it("parses HTTP dates relative to now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    expect(parseRetryAfterSeconds("Thu, 01 Jan 2026 00:01:00 GMT")).toBe(60);
    expect(parseRetryAfterSeconds("Wed, 31 Dec 2025 23:00:00 GMT")).toBe(0);
  });
});

describe("getRetryDelayMs", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prefers server retry-after over backoff", () => {
    expect(getRetryDelayMs(apiError(429, 3), 250, 1, 2, 30_000)).toBe(3000);
    expect(getRetryDelayMs(apiError(429, 0), 250, 1, 2, 30_000)).toBe(0);
  });

  it("uses exponential backoff without jitter at the midpoint", () => {
    midRandom();
    expect(getRetryDelayMs(new TypeError("x"), 250, 1, 2, 30_000)).toBe(500);
    expect(getRetryDelayMs(new TypeError("x"), 250, 2, 2, 30_000)).toBe(1000);
  });

  it("caps the delay at maxDelayMs and the exponent at 6", () => {
    midRandom();
    expect(getRetryDelayMs(new TypeError("x"), 250, 3, 2, 1000)).toBe(1000);
    expect(getRetryDelayMs(new TypeError("x"), 1, 6, 2, 1_000_000)).toBe(64);
    expect(getRetryDelayMs(new TypeError("x"), 1, 20, 2, 1_000_000)).toBe(64);
  });

  it("applies +-25% jitter", () => {
    const spy = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(((bytes: Uint32Array) => {
      bytes[0] = 0;
      return bytes;
    }) as typeof crypto.getRandomValues);
    expect(getRetryDelayMs(new TypeError("x"), 100, 1, 2, 30_000)).toBe(150);
    spy.mockRestore();
  });
});

describe("sleep", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves after the delay", async () => {
    const done = vi.fn();
    void sleep(100).then(done);
    await vi.advanceTimersByTimeAsync(99);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalled();
  });

  it("rejects immediately when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(100, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects when aborted during the wait", async () => {
    const controller = new AbortController();
    const promise = sleep(1000, controller.signal);
    const assertion = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("withRetry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns the first success without sleeping", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries retryable errors up to 1 + retries attempts", async () => {
    const fn = vi.fn().mockRejectedValue(apiError(503, 0));
    const promise = withRetry(fn, { retries: 2 });
    const assertion = expect(promise).rejects.toMatchObject({ status: 503 });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("defaults to two retries", async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError("net"));
    const promise = withRetry(fn);
    const assertion = expect(promise).rejects.toBeInstanceOf(TypeError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("succeeds after a transient failure", async () => {
    const fn = vi.fn().mockRejectedValueOnce(apiError(500, 1)).mockResolvedValue("ok");
    const promise = withRetry(fn);
    await vi.advanceTimersByTimeAsync(999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable errors, including timeouts and aborts", async () => {
    for (const error of [apiError(404), new RequestTimeoutError(), createAbortError(), new Error("x")]) {
      const fn = vi.fn().mockRejectedValue(error);
      await expect(withRetry(fn)).rejects.toBe(error);
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it("does not retry when retries is 0", async () => {
    const fn = vi.fn().mockRejectedValue(apiError(500));
    await expect(withRetry(fn, { retries: 0 })).rejects.toMatchObject({ status: 500 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws an AbortError without calling fn when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn();
    await expect(withRetry(fn, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("aborts while sleeping between attempts", async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue(apiError(500, 60));
    const promise = withRetry(fn, { signal: controller.signal });
    const assertion = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("honours server retry-after exactly when it is below maxDelayMs", async () => {
    const fn = vi.fn().mockRejectedValueOnce(apiError(429, 3)).mockResolvedValue("ok");
    const promise = withRetry(fn, { maxDelayMs: 10_000 });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe("ok");
  });

  it("fails with the real error instead of waiting past the deadline", async () => {
    const limited = apiError(429, 20);
    const fn = vi.fn().mockRejectedValueOnce(limited).mockResolvedValue("ok");
    const promise = withRetry(fn, { deadline: Date.now() + 12_000 });

    await expect(promise).rejects.toBe(limited);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("fails with the real error when the wait would leave too little time for another attempt", async () => {
    const limited = apiError(429, 11);
    const fn = vi.fn().mockRejectedValueOnce(limited).mockResolvedValue("ok");
    const promise = withRetry(fn, { deadline: Date.now() + 12_000 });

    await expect(promise).rejects.toBe(limited);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("bounds server retry-after by maxDelayMs", async () => {
    const fn = vi.fn().mockRejectedValueOnce(apiError(429, 100)).mockResolvedValue("ok");
    const promise = withRetry(fn, { maxDelayMs: 10 });
    await vi.advanceTimersByTimeAsync(9);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe("ok");
  });

  it("caps backoff delay at maxDelayMs", async () => {
    midRandom();
    const fn = vi.fn().mockRejectedValueOnce(new TypeError("x")).mockResolvedValue("ok");
    const promise = withRetry(fn, { baseDelayMs: 10_000, maxDelayMs: 200 });
    await vi.advanceTimersByTimeAsync(199);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe("ok");
  });
});
