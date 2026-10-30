import { describe, expect, it } from "vitest";
import { normalizeBffBaseUrl, normalizeReleaseBffBaseUrl } from "../../../../config/bffOriginPolicy";

describe("BFF origin policy", () => {
  it("allows only loopback HTTP in explicit development", () => {
    expect(normalizeBffBaseUrl("http://localhost:4000", true)).toBe("http://localhost:4000");
    expect(() => normalizeBffBaseUrl("http://api.example.test", true)).toThrow("HTTPS");
  });

  it("shares release validation between runtime and Expo configuration", () => {
    expect(normalizeReleaseBffBaseUrl("https://api.example.test/")).toBe("https://api.example.test");
    for (const origin of ["http://localhost:4000", "https://127.0.0.1", "https://user:pass@example.test", "https://api.example.test/path"]) {
      expect(() => normalizeReleaseBffBaseUrl(origin)).toThrow();
    }
  });
});
