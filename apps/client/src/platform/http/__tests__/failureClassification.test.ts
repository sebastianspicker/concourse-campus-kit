import { describe, expect, it } from "vitest";
import {
  ApiErrorException,
  isPublicDataRecoveryBlocked,
  isTransientPublicDataFailure,
  RequestTimeoutError,
} from "../errors";

const api = (code: string, status: number) => new ApiErrorException({ code, status, message: "m" });

describe("isTransientPublicDataFailure", () => {
  it("treats timeouts and network TypeErrors as transient", () => {
    expect(isTransientPublicDataFailure(new RequestTimeoutError())).toBe(true);
    expect(isTransientPublicDataFailure(new TypeError("x"))).toBe(true);
  });

  it.each([api])("treats 429 and 5xx responses as transient", (make) => {
    expect(isTransientPublicDataFailure(make("rate_limited", 429))).toBe(true);
    expect(isTransientPublicDataFailure(make("unknown_error", 500))).toBe(true);
    expect(isTransientPublicDataFailure(make("unknown_error", 503))).toBe(true);
  });

  it.each([api])("treats other statuses as not transient", (make) => {
    expect(isTransientPublicDataFailure(make("unknown_error", 400))).toBe(false);
    expect(isTransientPublicDataFailure(make("not_found", 404))).toBe(false);
    expect(isTransientPublicDataFailure(make("unknown_error", 499))).toBe(false);
  });

  it.each([api])("excludes non-retryable codes even with retryable statuses", (make) => {
    expect(isTransientPublicDataFailure(make("institution_mismatch", 500))).toBe(false);
    expect(isTransientPublicDataFailure(make("validation_error", 429))).toBe(false);
  });

  it("treats aborts, plain errors and non-errors as not transient", () => {
    expect(isTransientPublicDataFailure(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(false);
    expect(isTransientPublicDataFailure(new Error("x"))).toBe(false);
    expect(isTransientPublicDataFailure({ status: 500 })).toBe(false);
    expect(isTransientPublicDataFailure(null)).toBe(false);
    expect(isTransientPublicDataFailure("x")).toBe(false);
  });
});

describe("isPublicDataRecoveryBlocked", () => {
  it.each([api])("blocks only institution_mismatch and validation_error responses", (make) => {
    expect(isPublicDataRecoveryBlocked(make("institution_mismatch", 409))).toBe(true);
    expect(isPublicDataRecoveryBlocked(make("validation_error", 502))).toBe(true);
    expect(isPublicDataRecoveryBlocked(make("rate_limited", 429))).toBe(false);
    expect(isPublicDataRecoveryBlocked(make("unknown_error", 500))).toBe(false);
  });

  it("does not block transport failures or non-errors", () => {
    expect(isPublicDataRecoveryBlocked(new RequestTimeoutError())).toBe(false);
    expect(isPublicDataRecoveryBlocked(new TypeError("x"))).toBe(false);
    expect(isPublicDataRecoveryBlocked(new Error("institution_mismatch"))).toBe(false);
    expect(isPublicDataRecoveryBlocked({ code: "validation_error" })).toBe(false);
    expect(isPublicDataRecoveryBlocked(undefined)).toBe(false);
  });
});
