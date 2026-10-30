import { describe, expect, it } from "vitest";
import { ApiErrorException, RequestTimeoutError } from "../errors";
import { toUiError } from "../uiError";

function abortError(): Error {
  return Object.assign(new Error("whatever"), { name: "AbortError" });
}

describe.each([
  ["ApiErrorException", (code: string, status: number, retryAfterInSeconds?: number) =>
    new ApiErrorException({ message: "m", code, status, retryAfterInSeconds })],
])("toUiError with %s", (_name, make) => {
  it("maps stable codes", () => {
    expect(toUiError(make("institution_mismatch", 409))).toEqual({ kind: "institutionMismatch" });
    expect(toUiError(make("validation_error", 502))).toEqual({ kind: "invalidResponse" });
    expect(toUiError(make("timeout", 504))).toEqual({ kind: "timeout" });
    expect(toUiError(make("institution_not_found", 404))).toEqual({ kind: "notFound" });
  });

  it("distinguishes the not_found code from a 404 status", () => {
    expect(toUiError(make("not_found", 404))).toEqual({ kind: "unavailableSource" });
    expect(toUiError(make("unknown_error", 404))).toEqual({ kind: "notFound" });
  });

  it("maps rate limiting and carries retry-after", () => {
    expect(toUiError(make("rate_limited", 429, 12))).toEqual({ kind: "rateLimit", retryAfterInSeconds: 12 });
    expect(toUiError(make("unknown_error", 429, 7))).toEqual({ kind: "rateLimit", retryAfterInSeconds: 7 });
    expect(toUiError(make("unknown_error", 429))).toEqual({ kind: "rateLimit", retryAfterInSeconds: undefined });
  });

  it("maps 5xx to server and other statuses to unknown", () => {
    expect(toUiError(make("unknown_error", 500))).toEqual({ kind: "server" });
    expect(toUiError(make("whatever", 503))).toEqual({ kind: "server" });
    expect(toUiError(make("unknown_error", 400))).toEqual({ kind: "unknown" });
  });

  it("lets a known code win over a 5xx status", () => {
    expect(toUiError(make("institution_mismatch", 500))).toEqual({ kind: "institutionMismatch" });
  });
});

describe("toUiError transport failures", () => {
  it("maps RequestTimeoutError to timeout", () => {
    expect(toUiError(new RequestTimeoutError())).toEqual({ kind: "timeout" });
  });

  it("suppresses abort errors", () => {
    expect(toUiError(abortError())).toBeNull();
  });

  it("maps TypeError to offline", () => {
    expect(toUiError(new TypeError("Network request failed"))).toEqual({ kind: "offline" });
  });

  it("maps timeout or aborted wording to timeout", () => {
    expect(toUiError(new Error("Connection Timeout"))).toEqual({ kind: "timeout" });
    expect(toUiError(new Error("operation was aborted"))).toEqual({ kind: "timeout" });
  });

  it("maps everything else to unknown", () => {
    expect(toUiError(new Error("boom"))).toEqual({ kind: "unknown" });
    expect(toUiError("string")).toEqual({ kind: "unknown" });
    expect(toUiError(null)).toEqual({ kind: "unknown" });
  });
});
