/** Smoke-tests the README's local run: the bundled example pack in mock mode, with no upstream fetch. */

import http from "node:http";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  EventsResponseSchema,
  PublicResponseHeader,
  RoomsResponseSchema,
  ScheduleResponseSchema,
  TodayResponseSchema
} from "@concourse/contracts";

const { fetchTextWithTimeout } = vi.hoisted(() => ({
  fetchTextWithTimeout: vi.fn(async () => {
    throw new Error("The local run must not fetch upstream sources");
  })
}));

vi.mock("../sources/upstream/httpClient", () => ({ fetchTextWithTimeout }));

import { createTestConfig } from "../testing/config";
import { listenOnLoopback } from "../testing/loopback";
import { createRequestListener } from "./listener";

describe("documented local run (INSTITUTION_ID=example, PUBLIC_EVENTS_MODE=mock)", () => {
  it("serves every public route offline with schema-valid, non-empty data", async () => {
    const config = createTestConfig({ INSTITUTION_ID: "example", PUBLIC_EVENTS_MODE: "mock", PUBLIC_EVENTS_DATE: "2026-11-04T10:00:00.000Z" });
    const app = await listenOnLoopback(http.createServer(createRequestListener({ config })));

    const health = await request(app).get("/health").expect(200);
    const events = await request(app).get("/events").expect(200);
    const rooms = await request(app).get("/rooms").expect(200);
    const schedule = await request(app).get("/schedule").expect(200);
    const today = await request(app).get("/today").expect(200);

    expect(health.body).toMatchObject({ status: "ok", institution: "example" });
    expect(EventsResponseSchema.parse(events.body).events.length).toBeGreaterThan(0);
    expect(RoomsResponseSchema.parse(rooms.body).rooms.length).toBeGreaterThan(0);
    expect(ScheduleResponseSchema.parse(schedule.body).schedule.length).toBeGreaterThan(0);
    expect(TodayResponseSchema.parse(today.body).events.length).toBeGreaterThan(0);
    for (const response of [events, schedule, today]) {
      expect(response.headers[PublicResponseHeader.dataMode]).toBe("mock");
      expect(response.body._degraded).toBe(false);
    }
    expect(fetchTextWithTimeout).not.toHaveBeenCalled();
  });
});
