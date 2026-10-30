import {
  EventsResponseSchema,
  PublicQueryKey,
  PublicResponseHeader,
  PublicRoute,
  RoomsResponseSchema,
  ScheduleResponseSchema,
  TodayResponseSchema,
  type PublicDataRoute
} from "@concourse/contracts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ZodError, type z } from "zod";
import { InvalidQueryParameterError, NoConfiguredSourcesError } from "../application/errors";
import { getEvents } from "../application/events";
import { getRooms } from "../application/rooms";
import { getSchedule } from "../application/schedule";
import { getToday } from "../application/today";
import type { PublicDataSources } from "../application/publicSources";
import type { BffConfig } from "../runtime/config";
import type { InstitutionPack } from "../runtime/institution";
import { log } from "../runtime/logger";
import { fetchPublicSchedule } from "../sources/ics/publicSchedule";
import { fetchPublicEvents } from "../sources/web-events/publicEvents";
import { getStringParam, parseEventsQuery, parseQueryParams, parseRoomsQuery, parseScheduleQuery } from "./query";
import { ResponseBodyTooLargeError, sendError, sendJsonWithCache } from "./respond";

export type DataRouteHandler = (req: IncomingMessage, res: ServerResponse, institution: InstitutionPack, requestId: string) => Promise<void>;
type JsonRouteLoader = (institution: InstitutionPack, req: IncomingMessage) => Promise<unknown>;

export type DataRouteDependencies = {
  config: BffConfig;
  publicDataSources?: PublicDataSources;
  now?: Date;
};

export type DataRouteHandlers = Record<PublicDataRoute, DataRouteHandler>;

/** Sends an error envelope and records the case where the response could no longer be changed. */
export function sendLoggedError(res: ServerResponse, status: number, code: string, message: string): void {
  if (!sendError(res, status, code, message)) log("warn", "send_error_after_headers", { status, code, message });
}

function sendExpectedRouteError(res: ServerResponse, requestId: string, error: Error): boolean {
  if (error instanceof NoConfiguredSourcesError) {
    log("warn", "no_config_sources", { requestId, message: error.message });
    sendLoggedError(res, 404, "not_found", error.message);
    return true;
  }

  if (error instanceof InvalidQueryParameterError) {
    log("warn", "invalid_query_param", { requestId, message: error.message });
    sendLoggedError(res, 400, "bad_request", error.message);
    return true;
  }

  return false;
}

const TIMEOUT_ERROR_NAMES = new Set(["AbortError", "TimeoutError", "RequestTimeoutError"]);

function sendTimeoutRouteError(res: ServerResponse, requestId: string, error: Error): boolean {
  const normalizedMessage = error.message.toLowerCase();
  const isTimeout = TIMEOUT_ERROR_NAMES.has(error.name) || normalizedMessage.includes("timeout") || normalizedMessage.includes("timed out");
  if (!isTimeout) return false;
  log("error", "route_timeout", { requestId, message: error.message });
  sendLoggedError(res, 504, "timeout", "The request took too long. Please check your connection and try again.");
  return true;
}

function sendResponseBudgetRouteError(res: ServerResponse, requestId: string, error: Error): boolean {
  if (!(error instanceof ResponseBodyTooLargeError)) return false;
  log("error", "route_response_too_large", { requestId });
  sendLoggedError(res, 502, "response_too_large", "The upstream response was too large. Please try again later.");
  return true;
}

const VALIDATION_ERROR_CODE = "validation_error";

function handleJsonRouteError(res: ServerResponse, requestId: string, err: unknown): void {
  if (err instanceof ZodError) {
    log("warn", VALIDATION_ERROR_CODE, { requestId, issues: err.issues });
    sendLoggedError(res, 500, VALIDATION_ERROR_CODE, "The server received an unexpected data format. Please try again later.");
    return;
  }

  const error = err instanceof Error ? err : new Error(String(err));
  if (sendExpectedRouteError(res, requestId, error)) return;
  if (sendTimeoutRouteError(res, requestId, error)) return;
  if (sendResponseBudgetRouteError(res, requestId, error)) return;

  log("error", "route_error", { requestId });
  sendLoggedError(res, 500, "internal_error", "Something went wrong on our end. Please try again in a moment.");
}

export function createJsonRoute<T>(
  loader: JsonRouteLoader,
  schema: z.ZodType<T>,
  options: { maxAgeSeconds?: number; getExtraHeaders?: (data: T) => Record<string, string> } = {}
): DataRouteHandler {
  const maxAgeSeconds = options.maxAgeSeconds ?? 300;
  const getExtraHeaders = options.getExtraHeaders;

  return async (req, res, institution, requestId): Promise<void> => {
    try {
      const data = await loader(institution, req);
      const response = schema.parse(data);

      const headers = getExtraHeaders?.(response);
      sendJsonWithCache(req, res, response, { maxAgeSeconds, headers });
    } catch (err: unknown) {
      handleJsonRouteError(res, requestId, err);
    }
  };
}

/** Supplies cache, horizon, and mock-mode settings to the adapters without global config reads. */
function createPublicDataSources(config: BffConfig): PublicDataSources {
  const cacheTtlMs = config.defaultCacheTtl * 1000;
  return {
    fetchEvents: (institution) => fetchPublicEvents(institution, { cacheTtlMs, mode: config.publicEventsMode, date: config.publicEventsDate }),
    fetchSchedule: (institution) => fetchPublicSchedule(institution, { cacheTtlMs, rruleHorizonDays: config.rruleExpansionHorizonDays, mode: config.publicEventsMode, date: config.publicEventsDate })
  };
}

function createPublicDataHeaders(config: BffConfig): (data: { _degraded?: boolean }) => Record<string, string> {
  return (data) => ({
    ...(data._degraded ? { [PublicResponseHeader.dataDegraded]: "true" } : {}),
    ...(config.publicEventsMode === "mock" ? { [PublicResponseHeader.dataMode]: "mock" } : {})
  });
}

export function createDataRouteHandlers(dependencies: DataRouteDependencies): DataRouteHandlers {
  const { config } = dependencies;
  const publicDataSources = dependencies.publicDataSources ?? createPublicDataSources(config);
  const publicDataHeaders = createPublicDataHeaders(config);
  return {
    [PublicRoute.events]: createJsonRoute(
      (institution, req) => getEvents(institution, parseEventsQuery(parseQueryParams(req)), publicDataSources),
      EventsResponseSchema,
      { maxAgeSeconds: 300, getExtraHeaders: publicDataHeaders }
    ),
    [PublicRoute.rooms]: createJsonRoute(
      (institution, req) => getRooms(institution, parseRoomsQuery(parseQueryParams(req))),
      RoomsResponseSchema,
      { maxAgeSeconds: 300 }
    ),
    [PublicRoute.schedule]: createJsonRoute(
      (institution, req) => getSchedule(institution, parseScheduleQuery(parseQueryParams(req)), publicDataSources),
      ScheduleResponseSchema,
      { maxAgeSeconds: 300, getExtraHeaders: publicDataHeaders }
    ),
    [PublicRoute.today]: createJsonRoute(
      (institution, req) => getToday(
        institution,
        getStringParam(parseQueryParams(req), PublicQueryKey.date),
        publicDataSources,
        dependencies.now ?? config.publicEventsDate ?? new Date()
      ),
      TodayResponseSchema,
      { maxAgeSeconds: 300, getExtraHeaders: publicDataHeaders }
    )
  };
}
