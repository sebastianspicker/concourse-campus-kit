/** Implements timeout-aware JSON fetches and defensive fallback parsing of BFF failures. */
import { ApiErrorException, getApiErrorDetails, RequestTimeoutError } from "./errors";
import { parseRetryAfterSeconds } from "./retry";
import { PublicResponseHeader } from "@concourse/contracts";

type BffError = {
  code: string;
  message: string;
};

export type JsonResponse<T> = {
  data: T;
  headers: Headers;
};

type TimedRequest = {
  signal: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
};

/** Races a promise against cancellation and always detaches the abort listener. */
function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal, createAbortError: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => finish(() => reject(createAbortError()));
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };
    promise.then((value) => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)));
    if (signal.aborted) onAbort();
    else {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
  });
}

/** Rejects malformed, non-HTTP, or credential-bearing BFF URLs before a client request starts. */
function assertClientHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid BFF URL");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("BFF URL must use http or https");
  }

  if (parsed.username || parsed.password) {
    throw new Error("BFF URL must not include credentials");
  }
}

/** Fetches and validates a JSON response while respecting caller cancellation and a hard timeout. */
export async function fetchJsonResponseWithTimeout<T>(
  url: string,
  init?: RequestInit,
  timeoutMs = 10_000
): Promise<JsonResponse<T>> {
  assertClientHttpUrl(url);
  const request = createTimedRequest(init?.signal, timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: request.signal, redirect: "error" });
    return await parseJsonResponse<T>(response, request.signal);
  } catch (error: unknown) {
    // Keep the timeout semantic through response-body reads as well as the
    // initial header fetch. Caller cancellations remain AbortError.
    if (request.didTimeout()) throw new RequestTimeoutError();
    throw error;
  } finally {
    request.cleanup();
  }
}

/** Creates the independently abortable deadline signal used for one client request. */
function createTimedRequest(externalSignal: AbortSignal | null | undefined, timeoutMs: number): TimedRequest {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const unlinkAbortSignals = linkAbortSignals(controller, externalSignal);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      unlinkAbortSignals();
      clearTimeout(timeoutId);
    }
  };
}

/** Validates a response and returns its parsed JSON while preserving its headers. */
async function parseJsonResponse<T>(response: Response, signal: AbortSignal): Promise<JsonResponse<T>> {
  if (!response.ok) {
    throw await createApiErrorException(response, signal);
  }

  return {
    data: await parseJsonBody<T>(response, signal),
    headers: response.headers
  };
}

/** Builds the normalized HTTP failure consumed by retry and UI error handling. */
async function createApiErrorException(response: Response, signal: AbortSignal): Promise<ApiErrorException> {
  const bffError = await parseBffError(response, signal);
  const message = bffError.code === "unknown_error"
    ? `Request failed (${response.status})`
    : bffError.message;

  return new ApiErrorException({
    message,
    status: response.status,
    code: bffError.code,
    retryAfterInSeconds: parseRetryAfterSeconds(response.headers.get(PublicResponseHeader.retryAfter))
  });
}

/** Reads successful response bodies while preserving empty and no-content response semantics. */
async function parseJsonBody<T>(response: Response, signal: AbortSignal): Promise<T> {
  // Some BFF responses intentionally have no body; callers still expect an
  // object-shaped value so schema parsing can decide what to do next.
  if (response.status === 204) {
    return {} as T;
  }

  const text = await abortableResponseRead(response.text(), signal);
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // A 200 that is not JSON (captive portal, proxy page) is a transient gateway fault, so saved data can be used.
    throw new ApiErrorException({ message: "Response was not JSON", status: 502, code: "invalid_json", retryAfterInSeconds: undefined });
  }
}

/** Races a response-body read against caller cancellation and cleans up its listener. */
function abortableResponseRead<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const createAbortError = () => Object.assign(new Error("Aborted"), { name: "AbortError" });
  return raceWithAbort(promise, signal, createAbortError);
}

/** Safely extracts a BFF error payload, falling back when an error body is malformed. */
export async function parseBffError(response: Response, signal?: AbortSignal): Promise<BffError> {
  try {
    const read = response.json();
    const body: unknown = signal ? await abortableResponseRead(read, signal) : await read;
    return getApiErrorDetails(body, "Unknown error");
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    // Non-JSON error pages still map to the generic client error below.
  }

  return { code: "unknown_error", message: "Unknown error" };
}

/** Propagates external cancellation into the request controller and returns listener cleanup. */
function linkAbortSignals(
  controller: AbortController,
  external?: AbortSignal | null
): () => void {
  if (!external) {
    return () => undefined;
  }

  if (external.aborted) {
    controller.abort();
    return () => undefined;
  }

  const onAbort = () => controller.abort();
  external.addEventListener("abort", onAbort, { once: true });

  return () => external.removeEventListener("abort", onAbort);
}
