/** Verifies localization remains in the design-system presentation layer. */
import { describe, expect, it } from "vitest";
import { getErrorMessage, getErrorMessageKey, getErrorType } from "../errorStatePresentation";

describe("error presentation", () => {
  it("maps semantic HTTP failures to localized message keys outside the platform layer", () => {
    expect(getErrorMessageKey({ kind: "offline" })).toBe("errorOffline");
    expect(getErrorMessageKey({ kind: "institutionMismatch" })).toBe("errorInstitutionMismatch");
    expect(getErrorMessageKey({ kind: "rateLimit", retryAfterInSeconds: 20 })).toBe("errorRateLimit");
  });

  it("classifies errors into presentation types with a fallback", () => {
    expect(getErrorType({ kind: "offline" })).toBe("network");
    expect(getErrorType({ kind: "timeout" })).toBe("network");
    expect(getErrorType({ kind: "notFound" })).toBe("notFound");
    expect(getErrorType({ kind: "unavailableSource" })).toBe("notFound");
    expect(getErrorType({ kind: "server" })).toBe("generic");
    expect(getErrorType(undefined)).toBe("generic");
    expect(getErrorType(undefined, "network")).toBe("network");
  });

  it("prefers the error message key, then the supplied message, then the unknown fallback", () => {
    const translate = (key: string) => `t:${key}`;
    expect(getErrorMessage({ kind: "offline" }, "ignored", translate)).toBe("t:errorOffline");
    expect(getErrorMessage(undefined, "custom", translate)).toBe("custom");
    expect(getErrorMessage(undefined, undefined, translate)).toBe("t:errorUnknown");
  });
});
