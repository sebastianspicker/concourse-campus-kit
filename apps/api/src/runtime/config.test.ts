/** Pins environment parsing for the BFF configuration module. */

import { describe, expect, it } from "vitest";
import { loadConfig, type BffConfig } from "./config";

function load(env: Record<string, string | undefined>): BffConfig {
  return loadConfig({ INSTITUTION_ID: "mockuni", ...env });
}

describe("BFF configuration defaults", () => {
  it("applies documented defaults", () => {
    const env = load({});

    expect(env).toMatchObject({
      port: 4000,
      institutionId: "mockuni",
      corsOrigins: [],
      trustProxy: "never",
      trustedProxies: [],
      defaultCacheTtl: 300,
      rruleExpansionHorizonDays: 90,
      rateLimitMax: 60,
      rateLimitWindowSeconds: 60
    });
  });

  it("trims INSTITUTION_ID and splits CORS_ORIGINS on commas, dropping blanks", () => {
    const env = load({ INSTITUTION_ID: "  mockuni  ", CORS_ORIGINS: " https://a.example , ,https://b.example," });

    expect(env.institutionId).toBe("mockuni");
    expect(env.corsOrigins).toEqual(["https://a.example", "https://b.example"]);
  });

  it.each([undefined, "", "   "])("requires INSTITUTION_ID (%j)", (value) => {
    expect(() => load({ INSTITUTION_ID: value })).toThrow("INSTITUTION_ID is required");
  });
});

describe("BFF numeric bounds", () => {
  it.each(["1", "4000", "65535"])("accepts BFF_PORT=%s", (port) => {
    expect(load({ BFF_PORT: port }).port).toBe(Number(port));
  });

  it.each(["0", "65536", "abc", "1.5", "-1"])("rejects BFF_PORT=%s", (port) => {
    expect(() => load({ BFF_PORT: port })).toThrow(`Invalid BFF_PORT: ${port}`);
  });

  it.each(["1", "86400"])("accepts BFF_DEFAULT_CACHE_TTL=%s", (ttl) => {
    expect(load({ BFF_DEFAULT_CACHE_TTL: ttl }).defaultCacheTtl).toBe(Number(ttl));
  });

  it("rejects out-of-range or non-integer cache TTLs with specific messages", () => {
    expect(() => load({ BFF_DEFAULT_CACHE_TTL: "0" })).toThrow("BFF_DEFAULT_CACHE_TTL must be between 1 and 86400");
    expect(() => load({ BFF_DEFAULT_CACHE_TTL: "86401" })).toThrow("BFF_DEFAULT_CACHE_TTL must be between 1 and 86400");
    expect(() => load({ BFF_DEFAULT_CACHE_TTL: "x" })).toThrow("BFF_DEFAULT_CACHE_TTL must be an integer");
  });

  it("bounds RRULE_EXPANSION_HORIZON_DAYS to 1..366", () => {
    expect(load({ RRULE_EXPANSION_HORIZON_DAYS: "366" }).rruleExpansionHorizonDays).toBe(366);
    expect(() => load({ RRULE_EXPANSION_HORIZON_DAYS: "0" })).toThrow("RRULE_EXPANSION_HORIZON_DAYS must be between 1 and 366");
    expect(() => load({ RRULE_EXPANSION_HORIZON_DAYS: "367" })).toThrow("RRULE_EXPANSION_HORIZON_DAYS must be between 1 and 366");
    expect(() => load({ RRULE_EXPANSION_HORIZON_DAYS: "1.5" })).toThrow("RRULE_EXPANSION_HORIZON_DAYS must be an integer");
  });

  it("reads and bounds the per-client rate limit", () => {
    expect(load({ BFF_RATE_LIMIT_MAX: "600", BFF_RATE_LIMIT_WINDOW_SECONDS: "30" })).toMatchObject({ rateLimitMax: 600, rateLimitWindowSeconds: 30 });
    expect(() => load({ BFF_RATE_LIMIT_MAX: "0" })).toThrow("BFF_RATE_LIMIT_MAX must be between 1 and 100000");
    expect(() => load({ BFF_RATE_LIMIT_MAX: "100001" })).toThrow("BFF_RATE_LIMIT_MAX must be between 1 and 100000");
    expect(() => load({ BFF_RATE_LIMIT_WINDOW_SECONDS: "0" })).toThrow("BFF_RATE_LIMIT_WINDOW_SECONDS must be between 1 and 3600");
    expect(() => load({ BFF_RATE_LIMIT_WINDOW_SECONDS: "3601" })).toThrow("BFF_RATE_LIMIT_WINDOW_SECONDS must be between 1 and 3600");
    expect(() => load({ BFF_RATE_LIMIT_MAX: "ten" })).toThrow("BFF_RATE_LIMIT_MAX must be an integer");
  });
});

describe("BFF proxy trust configuration", () => {
  it.each([["never", "never"], ["always", "always"], [" ALWAYS ", "always"]])("parses BFF_TRUST_PROXY=%j", (raw, mode) => {
    expect(load({ BFF_TRUST_PROXY: raw }).trustProxy).toBe(mode);
  });

  it("rejects an unknown BFF_TRUST_PROXY value", () => {
    expect(() => load({ BFF_TRUST_PROXY: "sometimes" }))
      .toThrow("Invalid BFF_TRUST_PROXY: sometimes; use never, always, or BFF_TRUSTED_PROXIES");
  });

  it("implies trusted mode when ranges are set and no mode is given", () => {
    const env = load({ BFF_TRUSTED_PROXIES: "10.0.0.0/8, 192.168.1.1" });

    expect(env.trustProxy).toBe("trusted");
    expect(env.trustedProxies).toEqual(["10.0.0.0/8", "192.168.1.1"]);
    expect(env.trustedProxyMatcher.isTrusted("10.1.2.3")).toBe(true);
    expect(env.trustedProxyMatcher.isTrusted("11.1.2.3")).toBe(false);
  });

  it("lets an explicit mode override implicit trusted mode", () => {
    expect(load({ BFF_TRUST_PROXY: "never", BFF_TRUSTED_PROXIES: "10.0.0.0/8" }).trustProxy).toBe("never");
  });

  it.each(["not-an-ip", "10.0.0.0/33", "10.0.0.0/8/8", "::1/129", "10.0.0.0/x"])("rejects BFF_TRUSTED_PROXIES entry %s", (entry) => {
    expect(() => load({ BFF_TRUSTED_PROXIES: entry }))
      .toThrow(`Invalid BFF_TRUSTED_PROXIES entry: ${entry}; expected an IP address or CIDR range`);
  });
});

describe("BFF auth, version and events settings", () => {
  it("normalizes auth requirement and token without throwing for incomplete or invalid values", () => {
    expect(load({}).authRequirement).toBe("disabled");
    expect(load({ BFF_REQUIRE_AUTH: " YES ", BFF_AUTH_TOKEN: " t " })).toMatchObject({ authRequirement: "required", authToken: "t" });
    expect(load({ BFF_REQUIRE_AUTH: "off" }).authRequirement).toBe("disabled");
    expect(load({ BFF_REQUIRE_AUTH: "maybe" }).authRequirement).toBe("invalid");
    expect(load({ BFF_REQUIRE_AUTH: "true", BFF_AUTH_TOKEN: "  " }).authToken).toBeUndefined();
  });

  it("prefers APP_VERSION over npm_package_version and falls back to development", () => {
    expect(load({ APP_VERSION: "9.9.9", npm_package_version: "1.0.0" }).appVersion).toBe("9.9.9");
    expect(load({ npm_package_version: "1.0.0" }).appVersion).toBe("1.0.0");
    expect(load({}).appVersion).toBe("development");
  });

  it("defaults the events mode to auto and ignores an unparseable fixed date", () => {
    expect(load({}).publicEventsMode).toBe("auto");
    expect(load({ PUBLIC_EVENTS_MODE: "mock" }).publicEventsMode).toBe("mock");
    expect(load({ PUBLIC_EVENTS_DATE: "2026-08-28T12:00:00.000Z" }).publicEventsDate?.toISOString()).toBe("2026-08-28T12:00:00.000Z");
    expect(load({ PUBLIC_EVENTS_DATE: "not-a-date" }).publicEventsDate).toBeUndefined();
  });
});
