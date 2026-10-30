import { createAbortError } from "./errors";

function parseRetryAfterDate(retryAfter: string): number | undefined {
  const date = new Date(retryAfter);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000));
}

export function parseRetryAfterSeconds(retryAfter: string | null): number | undefined {
  if (!retryAfter) {
    return undefined;
  }

  // Retry-After can be either delay seconds or an absolute HTTP-date.
  const seconds = Number.parseInt(retryAfter, 10);
  return Number.isNaN(seconds) ? parseRetryAfterDate(retryAfter) : Math.max(0, seconds);
}

function isHttpLikeError(err: unknown): err is { status: number; retryAfterInSeconds?: number } {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    typeof (err as Record<string, unknown>).status === "number"
  );
}

export function shouldRetry(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return false;

  if (isHttpLikeError(err)) {
    if (err.status === 429) return true;
    return err.status >= 500;
  }

  // Network errors often surface as TypeError in fetch.
  return err instanceof TypeError;
}

function randomUnitInterval(): number {
  const bytes = new Uint32Array(1);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
    return bytes[0] / 0x100000000;
  }
  return 0.5;
}

function backoffWithJitter(
  baseDelayMs: number,
  attempt: number,
  multiplier: number,
  maxDelayMs: number
): number {
  const exp = Math.min(6, attempt);
  const calculated = baseDelayMs * Math.pow(multiplier, exp);
  // +-25% jitter: random in [-0.25, +0.25]
  const jitterFactor = (randomUnitInterval() - 0.5) * 0.5;
  const withJitter = calculated + jitterFactor * calculated;
  return Math.min(Math.floor(withJitter), maxDelayMs);
}

export function getRetryDelayMs(
  err: unknown,
  baseDelayMs: number,
  attempt: number,
  multiplier: number,
  maxDelayMs: number
): number {
  const retryAfterSeconds = isHttpLikeError(err) ? err.retryAfterInSeconds : undefined;
  const maximum = Math.max(0, maxDelayMs);
  return typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
    ? Math.min(retryAfterSeconds * 1000, maximum)
    : backoffWithJitter(baseDelayMs, attempt, multiplier, maximum);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(createAbortError());
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

type AttemptResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

function canRetry(error: unknown, attempt: number, retries: number): boolean {
  return attempt <= retries && shouldRetry(error);
}

// Time a retried attempt needs after its wait to be worth starting.
const MIN_ATTEMPT_AFTER_WAIT_MS = 2_000;

/** Waits for the next attempt, or fails now with the real error when the wait would leave no room for it before the caller's deadline. */
async function waitForRetry(error: unknown, delayMs: number, signal: AbortSignal | undefined, deadline: number | undefined): Promise<void> {
  if (deadline !== undefined && Date.now() + delayMs + MIN_ATTEMPT_AFTER_WAIT_MS >= deadline) throw error;
  await sleep(delayMs, signal);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: { retries?: number; baseDelayMs?: number; multiplier?: number; maxDelayMs?: number; signal?: AbortSignal; deadline?: number }
): Promise<T> {
  const retries = options?.retries ?? 2;
  const baseDelayMs = options?.baseDelayMs ?? 250;
  const multiplier = options?.multiplier ?? 2;
  const maxDelayMs = options?.maxDelayMs ?? 30_000;
  const signal = options?.signal;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal?.aborted) {
      throw createAbortError();
    }

    let result: AttemptResult<T>;
    try {
      result = { ok: true, value: await fn() };
    } catch (error: unknown) {
      result = { ok: false, error };
    }
    if (result.ok) {
      return result.value;
    }

    attempt += 1;
    if (!canRetry(result.error, attempt, retries)) {
      throw result.error;
    }

    const delay = getRetryDelayMs(result.error, baseDelayMs, attempt, multiplier, maxDelayMs);
    await waitForRetry(result.error, delay, signal, options?.deadline);
  }
}
