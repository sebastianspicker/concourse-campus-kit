/** Characterizes the externally visible HTTP contract at the BFF listener boundary. */

import http from "node:http";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EventsResponseSchema,
  PublicResponseHeader,
  RoomsResponseSchema,
  ScheduleResponseSchema,
  TodayResponseSchema,
  type PublicEvent,
  type ScheduleItem
} from "@concourse/contracts";
import type { InstitutionPack } from "@concourse/institutions";
import type { PublicDataSources } from "../application/publicSources";
import { createTestConfig } from "../testing/config";
import { listenOnLoopback } from "../testing/loopback";
import { createRequestListener, type RequestListenerDependencies } from "./listener";

const contractInstitution: InstitutionPack = {
  id: "contract-university",
  name: "Contract University",
  type: "university",
  campuses: [],
  publicSources: {
    events: [{ label: "Events", url: "https://events.example.org/public" }],
    schedules: [{ label: "Schedule", url: "https://events.example.org/schedule.ics" }]
  },
  publicRooms: [
    { id: "main-room", name: "Main Room", campusId: "main" },
    { id: "south-room", name: "South Room", campusId: "south" }
  ],
  timezone: "Europe/Berlin"
};

const contractEvents: PublicEvent[] = [
  { id: "lecture", title: "Open Lecture", date: "2026-08-28T09:00:00.000Z", sourceUrl: "https://events.example.org/lecture" },
  { id: "tomorrow", title: "Tomorrow Event", date: "2026-08-29T09:00:00.000Z", sourceUrl: "https://events.example.org/tomorrow" }
];
const contractSchedule: ScheduleItem[] = [
  { id: "main-lecture", title: "Main Lecture", startsAt: "2026-08-28T10:00:00.000Z", campusId: "main" },
  { id: "south-lecture", title: "South Lecture", startsAt: "2026-08-29T10:00:00.000Z", campusId: "south" }
];

function createContractSources(options: { degraded?: boolean; failEvents?: boolean } = {}): PublicDataSources {
  return {
    fetchEvents: async () => {
      if (options.failEvents) throw new Error("private upstream detail: secret-token");
      return { events: contractEvents, degraded: options.degraded ?? false };
    },
    fetchSchedule: async () => ({ schedule: contractSchedule, degraded: options.degraded ?? false })
  };
}

function createApp(
  dependencies: Partial<RequestListenerDependencies> = {},
  env: Record<string, string> = {}
): Promise<http.Server> {
  return listenOnLoopback(http.createServer(createRequestListener({ config: createTestConfig(env), ...dependencies })));
}

function createContractApp(options: { degraded?: boolean; failEvents?: boolean; institution?: InstitutionPack } = {}): Promise<http.Server> {
  return createApp({
    publicDataSources: createContractSources(options),
    now: new Date("2026-08-28T12:00:00.000Z"),
    institutionLoader: () => options.institution ?? contractInstitution
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createRequestListener HTTP characterization", () => {
  it("preserves valid request IDs on not-found responses with the stable error and security contract", async () => {
    const response = await request(await createApp())
      .get("/missing")
      .set("x-request-id", "characterization-request-1")
      .expect(404);

    expect(response.headers["x-request-id"]).toBe("characterization-request-1");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.body).toEqual({
      error: { code: "not_found", message: "Route not found" }
    });
  });

  it("handles OPTIONS before authentication or route loading", async () => {
    const authEnv = { BFF_REQUIRE_AUTH: "true", BFF_AUTH_TOKEN: "characterization-token" };

    const response = await request(await createApp({}, authEnv))
      .options("/today")
      .set("x-request-id", "characterization-request-2")
      .expect(204);

    expect(response.headers.allow).toBe("GET, OPTIONS");
    expect(response.headers["x-request-id"]).toBe("characterization-request-2");
    expect(response.text).toBe("");
  });

  it("rejects missing authentication before reporting an unsupported method", async () => {
    const authEnv = { BFF_REQUIRE_AUTH: "true", BFF_AUTH_TOKEN: "characterization-token" };

    const unauthenticated = await request(await createApp({}, authEnv)).post("/health").expect(401);
    const authenticated = await request(await createApp({}, authEnv))
      .post("/health")
      .set("authorization", "Bearer characterization-token")
      .expect(405);

    expect(unauthenticated.body.error.code).toBe("unauthorized");
    expect(authenticated.body.error.code).toBe("method_not_allowed");
    expect(authenticated.headers.allow).toBe("GET, OPTIONS");
  });

  it("serves health without contacting public upstream sources", async () => {
    const response = await request(await createApp())
      .get("/health")
      .set("x-request-id", "characterization-request-3")
      .expect(200);

    expect(response.headers["x-request-id"]).toBe("characterization-request-3");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toMatchObject({
      status: "ok",
      institution: "mockuni",
      checks: { institutionPack: { status: "ok" } }
    });
  });

  it("serves schema-valid events, rooms, schedule, and today through injected public sources", async () => {
    const app = await createContractApp({ degraded: true });
    const events = await request(app).get("/events?search=lecture&limit=1").expect(200);
    const rooms = await request(app).get("/rooms?campus=south&limit=1").expect(200);
    const schedule = await request(app).get("/schedule?campus=main&limit=1").expect(200);
    const today = await request(app).get("/today?date=2026-08-28").expect(200);

    expect(EventsResponseSchema.parse(events.body)).toMatchObject({ _total: 1, _degraded: true, _sourcesConfigured: true });
    expect(events.body.events).toEqual([contractEvents[0]]);
    expect(RoomsResponseSchema.parse(rooms.body)).toMatchObject({ _total: 1, _sourcesConfigured: true });
    expect(rooms.body.rooms).toEqual([contractInstitution.publicRooms![1]]);
    expect(ScheduleResponseSchema.parse(schedule.body)).toMatchObject({ _total: 1, _degraded: true, _sourcesConfigured: true });
    expect(schedule.body.schedule).toEqual([contractSchedule[0]]);
    expect(TodayResponseSchema.parse(today.body)).toMatchObject({ _degraded: true, _sourcesConfigured: true });
    expect(today.body.events).toEqual([contractEvents[0]]);
    expect(today.body.rooms).toEqual(contractInstitution.publicRooms);

    for (const response of [events, rooms, schedule, today]) {
      expect(response.headers[PublicResponseHeader.institutionId]).toBe(contractInstitution.id);
    }
    expect(events.headers[PublicResponseHeader.dataDegraded]).toBe("true");
    expect(schedule.headers[PublicResponseHeader.dataDegraded]).toBe("true");
    expect(today.headers[PublicResponseHeader.dataDegraded]).toBe("true");
    expect(rooms.headers[PublicResponseHeader.dataDegraded]).toBeUndefined();
    // P-5: degraded results must not outlive the BFF's own 60 s degraded cache in device HTTP caches.
    for (const response of [events, schedule, today]) expect(response.headers["cache-control"]).toBe("private, max-age=0");
    expect(rooms.headers["cache-control"]).toBe("private, max-age=300");
  });

  it.each(["/events", "/rooms", "/schedule", "/today"])("returns the stable no-source 404 for %s", async (path) => {
    const emptyInstitution: InstitutionPack = { ...contractInstitution, publicSources: {}, publicRooms: [] };
    const response = await request(await createContractApp({ institution: emptyInstitution })).get(path).expect(404);

    expect(response.body.error.code).toBe("not_found");
    expect(response.headers[PublicResponseHeader.institutionId]).toBe(emptyInstitution.id);
  });

  it("does not leak an injected public-source failure through the events route", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const response = await request(await createContractApp({ failEvents: true })).get("/events").expect(500);

    expect(response.body).toEqual({
      error: { code: "internal_error", message: "Something went wrong on our end. Please try again in a moment." }
    });
    expect(JSON.stringify(response.body)).not.toContain("secret-token");
    expect(logSpy.mock.calls.flat().join("\n")).not.toContain("secret-token");
    expect(response.headers[PublicResponseHeader.institutionId]).toBe(contractInstitution.id);
    logSpy.mockRestore();
  });
});
