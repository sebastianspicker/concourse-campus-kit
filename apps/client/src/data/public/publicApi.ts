/** Coordinates cache keys, validation, persistence, and freshness metadata for public requests. */
import {
  EventsResponseSchema,
  PublicRoute,
  type EventsResponse,
  type PublicEventsQuery,
  type PublicRoomsQuery,
  type PublicScheduleQuery,
  type PublicTodayQuery,
  type RoomsResponse,
  RoomsResponseSchema,
  type ScheduleResponse,
  TodayResponseSchema,
  ScheduleResponseSchema,
  type TodayResponse,
} from "@concourse/contracts";
import type { z } from "zod";
import { getJsonResult } from "@/platform/http/client";
import { ApiErrorException } from "@/platform/http/errors";
import { shareLoad } from "./cache";
import { getPublicCacheKey } from "./publicCacheKey";
import { fetchNetworkFirstWithFallback } from "./persistedCache";
import { isStaticDemo } from "./staticDemo";
import { getStaticDemoResponse } from "./staticDemoData";

export type RequestControls = {
  signal?: AbortSignal;
};

type CachedJsonOptions = RequestControls & { queryParams?: Record<string, string> };

export type ResourceLoadResult<T> = {
  data: T;
  source: "network" | "memory-cache" | "persisted-cache";
  updatedAt: number;
  cacheAge: number | null;
};

/** Converts schema-parser failures into an unavailable result instead of throwing into the UI. */
function safeParse<T>(data: unknown, schema: z.ZodType<T>): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ApiErrorException({
      status: 502,
      code: "validation_error",
      message: "Invalid response format"
    });
  }
  return result.data;
}

/** Encodes only defined filters before adding them to an endpoint URL. */
function getQueryString(queryParams?: Record<string, string>): string {
  const query = queryParams ? new URLSearchParams(queryParams).toString() : "";
  return query ? `?${query}` : "";
}

/**
 * Loads a public resource through the persisted-cache layer while preserving
 * whether a result is fresh, stale, or degraded for the UI.
 */
async function getCachedJson<T>(
  path: string,
  schema: z.ZodType<T>,
  keySuffix: string,
  options?: CachedJsonOptions
): Promise<ResourceLoadResult<T>> {
  const cacheKey = getPublicCacheKey(keySuffix, options?.queryParams);
  const queryString = getQueryString(options?.queryParams);

  if (isStaticDemo()) {
    return {
      data: safeParse(getStaticDemoResponse(path, options?.queryParams), schema),
      source: "memory-cache",
      updatedAt: Date.now(),
      cacheAge: 0,
    };
  }

  return shareLoad(
    cacheKey,
    async (sharedSignal) => {
      const result = await fetchNetworkFirstWithFallback<T>(
        cacheKey,
        async () => (await getJsonResult<T>(
          `${path}${queryString}`,
          (data) => safeParse(data, schema),
          { signal: sharedSignal },
        )).data,
        (value): value is T => schema.safeParse(value).success,
      );
      return {
        data: result.data,
        source: result.fromCache ? "persisted-cache" as const : "network" as const,
        updatedAt: Date.now() - (result.cacheAge ?? 0),
        cacheAge: result.cacheAge,
      };
    },
    options?.signal,
  );
}

export type EventsQuery = PublicEventsQuery;

type PublicRequestOptions<Q> = Q & RequestControls;
type PublicQuery = Record<string, string | number | undefined>;

function serializeQuery(query: PublicQuery): Record<string, string> {
  return Object.fromEntries(
    Object.entries(query).flatMap(([key, value]) => value === undefined || value === "" ? [] : [[key, String(value)]])
  );
}

function dispatchPublicEndpoint<T, Q extends PublicQuery>(
  options: PublicRequestOptions<Q>,
  path: string,
  schema: z.ZodType<T>,
  keySuffix: string
): Promise<ResourceLoadResult<T>> {
  const { signal, ...query } = options;

  return getCachedJson(path, schema, keySuffix, { signal, queryParams: serializeQuery(query) });
}

export function fetchEvents(options: PublicRequestOptions<EventsQuery> = {}): Promise<ResourceLoadResult<EventsResponse>> {
  return dispatchPublicEndpoint(options, PublicRoute.events, EventsResponseSchema, "events");
}

export type RoomsQuery = PublicRoomsQuery;

export function fetchRooms(options: PublicRequestOptions<RoomsQuery> = {}): Promise<ResourceLoadResult<RoomsResponse>> {
  return dispatchPublicEndpoint(options, PublicRoute.rooms, RoomsResponseSchema, "rooms");
}

export type TodayQuery = PublicTodayQuery;

export function fetchToday(options: PublicRequestOptions<TodayQuery> = {}): Promise<ResourceLoadResult<TodayResponse>> {
  return dispatchPublicEndpoint(options, PublicRoute.today, TodayResponseSchema, "today");
}

export type ScheduleQuery = PublicScheduleQuery;

export function fetchSchedule(options: PublicRequestOptions<ScheduleQuery> = {}): Promise<ResourceLoadResult<ScheduleResponse>> {
  return dispatchPublicEndpoint(options, PublicRoute.schedule, ScheduleResponseSchema, "schedule");
}
