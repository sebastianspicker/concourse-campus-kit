import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicResponseHeader } from "@concourse/contracts";
import { ApiErrorException, RequestTimeoutError } from "../errors";
import { fetchJsonResponseWithTimeout, parseBffError } from "../fetchHelpers";

const URL_OK = "https://bff.example/v1/x";

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
}

function hangingFetch(_url: string, init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (init.signal?.aborted) fail();
    else init.signal?.addEventListener("abort", fail);
  });
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("fetchJsonResponseWithTimeout success", () => {
  it("returns parsed JSON with headers and forbids redirects", async () => {
    const fetchFn = stubFetch(async () => new Response(JSON.stringify({ a: 1 }), { status: 200, headers: { "x-t": "1" } }));
    const result = await fetchJsonResponseWithTimeout<{ a: number }>(URL_OK, { method: "GET" });
    expect(result.data).toEqual({ a: 1 });
    expect(result.headers.get("x-t")).toBe("1");
    expect(fetchFn.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "error" });
  });

  it("returns an empty object for 204 and empty bodies", async () => {
    stubFetch(async () => new Response(null, { status: 204 }));
    expect((await fetchJsonResponseWithTimeout(URL_OK)).data).toEqual({});
    stubFetch(async () => new Response("", { status: 200 }));
    expect((await fetchJsonResponseWithTimeout(URL_OK)).data).toEqual({});
  });

  it("rejects malformed success bodies with a SyntaxError", async () => {
    stubFetch(async () => new Response("{nope", { status: 200 }));
    expect(await failure(fetchJsonResponseWithTimeout(URL_OK))).toBeInstanceOf(SyntaxError);
  });
});

describe("fetchJsonResponseWithTimeout URL validation", () => {
  it("rejects invalid, non-http and credential URLs before fetching", async () => {
    const fetchFn = stubFetch(async () => new Response("{}"));
    await expect(fetchJsonResponseWithTimeout("nope")).rejects.toThrow("Invalid BFF URL");
    await expect(fetchJsonResponseWithTimeout("ftp://x.example/")).rejects.toThrow("BFF URL must use http or https");
    await expect(fetchJsonResponseWithTimeout("https://u:p@x.example/")).rejects.toThrow("BFF URL must not include credentials");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("fetchJsonResponseWithTimeout failures", () => {
  it("maps non-2xx to an error with code, status and retry-after", async () => {
    stubFetch(async () => new Response(
      JSON.stringify({ error: { code: "rate_limited", message: "Slow down" } }),
      { status: 429, headers: { [PublicResponseHeader.retryAfter]: "9" } },
    ));
    const error = await failure(fetchJsonResponseWithTimeout(URL_OK));
    expect(error).toBeInstanceOf(ApiErrorException);
    expect(error).toMatchObject({ code: "rate_limited", message: "Slow down", status: 429, retryAfterInSeconds: 9 });
  });

  it("uses a generic message for malformed or code-less error bodies", async () => {
    stubFetch(async () => new Response("<html>", { status: 502 }));
    expect(await failure(fetchJsonResponseWithTimeout(URL_OK))).toMatchObject({
      code: "unknown_error", message: "Request failed (502)", status: 502, retryAfterInSeconds: undefined,
    });
    stubFetch(async () => new Response(JSON.stringify({ error: { message: "x" } }), { status: 500 }));
    expect(await failure(fetchJsonResponseWithTimeout(URL_OK))).toMatchObject({
      code: "unknown_error", message: "Request failed (500)",
    });
  });

  it("propagates network TypeErrors", async () => {
    stubFetch(async () => { throw new TypeError("Network request failed"); });
    expect(await failure(fetchJsonResponseWithTimeout(URL_OK))).toBeInstanceOf(TypeError);
  });

  it("rejects with RequestTimeoutError when the deadline expires", async () => {
    vi.useFakeTimers();
    stubFetch(hangingFetch);
    const promise = failure(fetchJsonResponseWithTimeout(URL_OK, undefined, 500));
    await vi.advanceTimersByTimeAsync(500);
    const error = await promise;
    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect((error as Error).message).toBe("Request timed out");
  });

  it("keeps caller cancellation as AbortError", async () => {
    vi.useFakeTimers();
    stubFetch(hangingFetch);
    const controller = new AbortController();
    const promise = failure(fetchJsonResponseWithTimeout(URL_OK, { signal: controller.signal }, 500));
    controller.abort();
    const error = await promise;
    expect(error).not.toBeInstanceOf(RequestTimeoutError);
    expect(error).toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with AbortError when the caller signal is already aborted", async () => {
    stubFetch(hangingFetch);
    const controller = new AbortController();
    controller.abort();
    expect(await failure(fetchJsonResponseWithTimeout(URL_OK, { signal: controller.signal }))).toMatchObject({ name: "AbortError" });
  });

  it("reports a timeout that fires during the body read", async () => {
    vi.useFakeTimers();
    const body = { ok: true, status: 200, headers: new Headers(), text: () => new Promise<string>(() => undefined) };
    stubFetch(async () => body as unknown as Response);
    const promise = failure(fetchJsonResponseWithTimeout(URL_OK, undefined, 100));
    await vi.advanceTimersByTimeAsync(100);
    expect(await promise).toBeInstanceOf(RequestTimeoutError);
  });
});

describe("parseBffError", () => {
  beforeEach(() => vi.useRealTimers());

  it("reads code and message from the envelope", async () => {
    const response = new Response(JSON.stringify({ error: { code: "c", message: "m" } }));
    expect(await parseBffError(response)).toEqual({ code: "c", message: "m" });
  });

  it("falls back for non-JSON and non-envelope bodies", async () => {
    expect(await parseBffError(new Response("x"))).toEqual({ code: "unknown_error", message: "Unknown error" });
    expect(await parseBffError(new Response(JSON.stringify({ error: "x" })))).toEqual({
      code: "unknown_error", message: "Unknown error",
    });
    expect(await parseBffError(new Response(JSON.stringify({ error: { code: 1, message: 2 } })))).toEqual({
      code: "unknown_error", message: "Unknown error",
    });
  });

  it("rethrows an abort that happens during the read", async () => {
    const controller = new AbortController();
    controller.abort();
    const response = new Response(JSON.stringify({}));
    await expect(parseBffError(response, controller.signal)).rejects.toMatchObject({ name: "AbortError", message: "Aborted" });
  });
});
