/** Pins listener-level behaviour (rate limits, caching, CORS, errors, proxy identity) before the layout refactor. */

import http from "node:http";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicResponseHeader, type PublicEvent, type ScheduleItem } from "@concourse/contracts";
import type { InstitutionPack } from "@concourse/institutions";
import type { PublicDataSources } from "../application/publicSources";
import { createTestConfig } from "../testing/config";
import { listenOnLoopback } from "../testing/loopback";
import { createRequestListener, type RequestListenerDependencies } from "./listener";

const institution: InstitutionPack = {
  id: "contract-university",
  name: "Contract University",
  type: "university",
  campuses: [],
  publicSources: {
    events: [{ label: "Events", url: "https://events.example.org/public" }],
    schedules: [{ label: "Schedule", url: "https://events.example.org/schedule.ics" }]
  },
  publicRooms: [{ id: "main-room", name: "Main Room", campusId: "main" }],
  timezone: "Europe/Berlin"
};
const events: PublicEvent[] = [
  { id: "lecture", title: "Open Lecture", date: "2026-08-28T09:00:00.000Z", sourceUrl: "https://events.example.org/lecture" }
];
const schedule: ScheduleItem[] = [
  { id: "main-lecture", title: "Main Lecture", startsAt: "2026-08-28T10:00:00.000Z", campusId: "main" }
];
const okSources: PublicDataSources = {
  fetchEvents: async () => ({ events, degraded: false }),
  fetchSchedule: async () => ({ schedule, degraded: false })
};
const NOW = new Date("2026-08-28T12:00:00.000Z");

/** Builds a listener from injected config; each listener owns its own rate-limit state. */
async function createApp(env: Record<string, string> = {}, dependencies: Partial<RequestListenerDependencies> = {}): Promise<http.Server> {
  return listenOnLoopback(http.createServer(createRequestListener({
    config: createTestConfig(env),
    publicDataSources: okSources,
    now: NOW,
    institutionLoader: () => institution,
    ...dependencies
  })));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listener rate limiting", () => {
  it("rejects the 61st request in a window with 429 and retry-after", async () => {
    const app = await createApp();
    for (let i = 0; i < 60; i += 1) await request(app).get("/health").expect(200);
    const limited = await request(app).get("/health").expect(429);

    expect(limited.body).toEqual({ error: { code: "rate_limited", message: "Too many requests" } });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers["retry-after"])).toBeLessThanOrEqual(60);
    expect(limited.headers["cache-control"]).toBe("no-store");
  });

  it("applies the configured request limit and window", async () => {
    const app = await createApp({ BFF_RATE_LIMIT_MAX: "3", BFF_RATE_LIMIT_WINDOW_SECONDS: "10" });
    for (let i = 0; i < 3; i += 1) await request(app).get("/health").expect(200);
    const limited = await request(app).get("/health").expect(429);

    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers["retry-after"])).toBeLessThanOrEqual(10);
  });

  it("throttles repeated invalid credentials in a separate bucket and still admits valid ones", async () => {
    const app = await createApp({ BFF_REQUIRE_AUTH: "true", BFF_AUTH_TOKEN: "secret-token" });
    for (let i = 0; i < 60; i += 1) {
      await request(app).get("/health").set("authorization", "Bearer wrong").expect(401);
    }
    const limited = await request(app).get("/health").set("authorization", "Bearer wrong").expect(429);
    const valid = await request(app).get("/health").set("authorization", "Bearer secret-token").expect(200);

    expect(limited.body.error.code).toBe("rate_limited");
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(valid.body.status).toBe("ok");
  });
});

describe("listener conditional caching", () => {
  it("serves data routes with a private max-age ETag", async () => {
    const response = await request(await createApp()).get("/events").expect(200);

    expect(response.headers["cache-control"]).toBe("private, max-age=300");
    expect(response.headers.etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(response.headers["content-type"]).toContain("application/json");
  });

  it("answers 304 for a matching If-None-Match, including W/ prefix and comma lists", async () => {
    const app = await createApp();
    const etag = (await request(app).get("/rooms")).headers.etag as string;

    for (const header of [etag, `W/${etag}`, `"other", W/${etag}`, `"other",${etag}`]) {
      const response = await request(app).get("/rooms").set("if-none-match", header).expect(304);
      expect(response.text).toBe("");
      expect(response.headers.etag).toBe(etag);
      expect(response.headers["cache-control"]).toBe("private, max-age=300");
    }
    await request(app).get("/rooms").set("if-none-match", '"different"').expect(200);
  });
});

describe("listener query parsing", () => {
  it.each(["0", "1001", "-1", "1.5", "abc", ""])("rejects limit=%s with 400 bad_request", async (limit) => {
    const response = await request(await createApp()).get(`/events?limit=${limit}`).expect(400);

    expect(response.body.error).toEqual({ code: "bad_request", message: "limit must be an integer between 1 and 1000" });
  });

  it.each([["1"], ["1000"]])("accepts limit=%s", async (limit) => {
    await request(await createApp()).get(`/events?limit=${limit}`).expect(200);
  });

  it("ignores unparseable offset, from and to values", async () => {
    const response = await request(await createApp())
      .get("/events?offset=abc&from=not-a-date&to=also-bad")
      .expect(200);

    expect(response.body.events).toEqual(events);
    expect(response.body._total).toBe(1);
  });

  it("clamps negative offsets to zero and floors fractional ones", async () => {
    const negative = await request(await createApp()).get("/events?offset=-5").expect(200);
    const beyond = await request(await createApp()).get("/events?offset=1.9").expect(200);

    expect(negative.body.events).toEqual(events);
    expect(beyond.body.events).toEqual([]);
  });

  it("rejects an invalid today date with 400 bad_request", async () => {
    const response = await request(await createApp()).get("/today?date=invalid").expect(400);

    expect(response.body.error).toEqual({ code: "bad_request", message: "date must be a valid YYYY-MM-DD calendar date" });
  });

  it("rejects a well-formed but impossible calendar date", async () => {
    await request(await createApp()).get("/today?date=2026-02-30").expect(400);
  });
});

describe("listener CORS and preflight", () => {
  const origin = "https://app.example.org";

  it("emits CORS headers only for an allowed origin", async () => {
    const app = await createApp({ CORS_ORIGINS: origin });
    const allowed = await request(app).get("/rooms").set("origin", origin).expect(200);
    const denied = await request(app).get("/rooms").set("origin", "https://evil.example.org").expect(200);

    expect(allowed.headers["access-control-allow-origin"]).toBe(origin);
    expect(allowed.headers["access-control-allow-methods"]).toBe("GET, OPTIONS");
    expect(allowed.headers.vary).toContain("origin");
    expect(allowed.headers["access-control-expose-headers"]).toContain(PublicResponseHeader.retryAfter);
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("uses a wildcard origin when configured and none when CORS_ORIGINS is unset", async () => {
    const wildcard = await request(await createApp({ CORS_ORIGINS: "*" })).get("/rooms").set("origin", origin);
    const none = await request(await createApp({ CORS_ORIGINS: "" })).get("/rooms").set("origin", origin);

    expect(wildcard.headers["access-control-allow-origin"]).toBe("*");
    expect(none.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers OPTIONS with 204, Allow and CORS headers for an allowed origin", async () => {
    const response = await request(await createApp({ CORS_ORIGINS: origin }))
      .options("/events")
      .set("origin", origin)
      .expect(204);

    expect(response.headers.allow).toBe("GET, OPTIONS");
    expect(response.headers["access-control-allow-origin"]).toBe(origin);
  });
});

describe("listener health, institution and method errors", () => {
  it("reports health ok", async () => {
    const response = await request(await createApp()).get("/health").expect(200);

    expect(response.body).toMatchObject({ status: "ok", institution: "mockuni" });
  });

  it("reports health 503 when the institution pack cannot be loaded", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const app = await createApp({}, { institutionLoader: () => { throw new Error("pack failed"); } });
    const response = await request(app).get("/health").expect(503);

    expect(response.body.status).toBe("error");
    expect(response.body.checks.institutionPack).toEqual({ status: "error", message: "Failed to load institution pack" });
  });

  it("returns 404 institution_not_found for an unknown institution", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const app = await createApp({ INSTITUTION_ID: "no-such-institution" }, { institutionLoader: undefined });
    const response = await request(app).get("/events").expect(404);

    expect(response.body.error).toEqual({
      code: "institution_not_found",
      message: "The requested institution is not configured"
    });
  });

  it("returns 500 internal_error when the institution loader fails for another reason", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const app = await createApp({}, { institutionLoader: () => { throw new Error("boom"); } });
    const response = await request(app).get("/events").expect(500);

    expect(response.body.error).toEqual({
      code: "internal_error",
      message: "An internal error occurred while loading configuration"
    });
  });

  it("returns 405 with Allow for POST on a data route", async () => {
    const response = await request(await createApp()).post("/events").expect(405);

    expect(response.headers.allow).toBe("GET, OPTIONS");
    expect(response.body.error.code).toBe("method_not_allowed");
  });
});

describe("listener data headers and source failures", () => {
  it("sets x-data-degraded only when sources report degraded data", async () => {
    const degraded: PublicDataSources = {
      fetchEvents: async () => ({ events, degraded: true }),
      fetchSchedule: async () => ({ schedule, degraded: true })
    };
    const app = await createApp({}, { publicDataSources: degraded });
    const healthy = await request(await createApp()).get("/events").expect(200);

    expect((await request(app).get("/events").expect(200)).headers[PublicResponseHeader.dataDegraded]).toBe("true");
    expect((await request(app).get("/schedule").expect(200)).headers[PublicResponseHeader.dataDegraded]).toBe("true");
    expect(healthy.headers[PublicResponseHeader.dataDegraded]).toBeUndefined();
  });

  it("sets x-data-mode only when PUBLIC_EVENTS_MODE is mock", async () => {
    const mock = await request(await createApp({ PUBLIC_EVENTS_MODE: "mock" })).get("/events").expect(200);
    const live = await request(await createApp({ PUBLIC_EVENTS_MODE: "live" })).get("/events").expect(200);
    const rooms = await request(await createApp({ PUBLIC_EVENTS_MODE: "mock" })).get("/rooms").expect(200);

    expect(mock.headers[PublicResponseHeader.dataMode]).toBe("mock");
    expect(live.headers[PublicResponseHeader.dataMode]).toBeUndefined();
    expect(rooms.headers[PublicResponseHeader.dataMode]).toBeUndefined();
  });

  it("maps a total schedule source failure to 500 internal_error without leaking detail", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const failing: PublicDataSources = {
      fetchEvents: okSources.fetchEvents,
      fetchSchedule: async () => { throw new Error("upstream detail: secret-token"); }
    };
    const response = await request(await createApp({}, { publicDataSources: failing })).get("/schedule").expect(500);

    expect(response.body).toEqual({
      error: { code: "internal_error", message: "Something went wrong on our end. Please try again in a moment." }
    });
    expect(JSON.stringify(response.body)).not.toContain("secret-token");
  });

  it("maps timeout-shaped source failures to 504 timeout", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const timingOut: PublicDataSources = {
      fetchEvents: async () => { throw new Error("request timed out"); },
      fetchSchedule: okSources.fetchSchedule
    };
    const response = await request(await createApp({}, { publicDataSources: timingOut })).get("/events").expect(504);

    expect(response.body.error.code).toBe("timeout");
  });
});

describe("listener forwarded client identity", () => {
  const exhaust = async (app: http.Server, forwardedFor: (i: number) => string): Promise<number> => {
    let last = 0;
    for (let i = 0; i < 61; i += 1) {
      last = (await request(app).get("/health").set("x-forwarded-for", forwardedFor(i))).status;
    }
    return last;
  };

  it("ignores X-Forwarded-For by default, keying the limit on the socket address", async () => {
    const app = await createApp();

    expect(await exhaust(app, (i) => `203.0.113.${i + 1}`)).toBe(429);
  });

  it("honours X-Forwarded-For from a trusted proxy peer", async () => {
    const app = await createApp({ BFF_TRUSTED_PROXIES: "127.0.0.1,::1,::ffff:127.0.0.1" });

    expect(await exhaust(app, (i) => `203.0.113.${i + 1}`)).toBe(200);
  });

  it("limits a single forwarded client behind a trusted proxy", async () => {
    const app = await createApp({ BFF_TRUSTED_PROXIES: "127.0.0.1,::1,::ffff:127.0.0.1" });

    expect(await exhaust(app, () => "203.0.113.9")).toBe(429);
  });

  it("trusts the last forwarded hop when BFF_TRUST_PROXY=always", async () => {
    const app = await createApp({ BFF_TRUST_PROXY: "always" });

    expect(await exhaust(app, (i) => `203.0.113.${i + 1}`)).toBe(200);
  });

  it("keeps BFF_TRUST_PROXY=never authoritative over configured proxy ranges", async () => {
    const app = await createApp({ BFF_TRUST_PROXY: "never", BFF_TRUSTED_PROXIES: "127.0.0.1,::1,::ffff:127.0.0.1" });

    expect(await exhaust(app, (i) => `203.0.113.${i + 1}`)).toBe(429);
  });
});
