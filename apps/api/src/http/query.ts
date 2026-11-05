import type { IncomingMessage } from "node:http";
import { PublicQueryKey } from "@concourse/contracts";
import { InvalidQueryParameterError } from "../application/errors";
import type { EventsQuery, RoomsQuery, ScheduleQuery } from "../application/queries";

export function parseQueryParams(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? "", "http://localhost").searchParams;
  } catch {
    return new URLSearchParams();
  }
}

export function getStringParam(params: URLSearchParams, key: string): string | undefined {
  return params.get(key) ?? undefined;
}

function getBoundedLimitParam(params: URLSearchParams, key: string): number | undefined {
  const value = params.get(key);
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
    throw new InvalidQueryParameterError(`${key} must be an integer between 1 and 1000`);
  }
  return parsed;
}

function getDateParam(params: URLSearchParams, key: string): Date | undefined {
  const value = params.get(key);
  if (value === null) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new InvalidQueryParameterError(`${key} must be an ISO 8601 date-time`);
  return date;
}

function getOffsetParam(params: URLSearchParams): number {
  const value = params.get(PublicQueryKey.offset);
  if (value === null) return 0;
  const parsed = Number(value);
  if (!/^\d{1,15}$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new InvalidQueryParameterError("offset must be a non-negative integer");
  }
  return parsed;
}

function parseDateRangePaginationQuery(params: URLSearchParams): EventsQuery {
  return {
    search: getStringParam(params, PublicQueryKey.search)?.slice(0, 200),
    fromDate: getDateParam(params, PublicQueryKey.from),
    toDate: getDateParam(params, PublicQueryKey.to),
    limit: getBoundedLimitParam(params, PublicQueryKey.limit),
    offset: getOffsetParam(params)
  };
}

export function parseEventsQuery(params: URLSearchParams): EventsQuery {
  return parseDateRangePaginationQuery(params);
}

export function parseScheduleQuery(params: URLSearchParams): ScheduleQuery {
  return { ...parseDateRangePaginationQuery(params), campusId: getStringParam(params, PublicQueryKey.campus)?.slice(0, 100) };
}

export function parseRoomsQuery(params: URLSearchParams): RoomsQuery {
  return {
    campus: getStringParam(params, PublicQueryKey.campus)?.slice(0, 100),
    search: getStringParam(params, PublicQueryKey.search)?.slice(0, 200),
    limit: getBoundedLimitParam(params, PublicQueryKey.limit),
    offset: getOffsetParam(params)
  };
}
