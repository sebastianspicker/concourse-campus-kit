/** Tracks the institution-local date and loads the public campus resources, always network-first. */
import { useEffect, useState } from "react";
import type { EventsResponse, RoomsResponse, ScheduleResponse, TodayResponse } from "@concourse/contracts";
import { getInstitutionTimeZone } from "@/platform/env/institution";
import { getCampusDate, millisecondsUntilNextCampusDay } from "@/platform/time/campusTime";
import {
  fetchEvents,
  fetchRooms,
  fetchSchedule,
  fetchToday,
  type EventsQuery,
  type ResourceLoadResult,
  type RoomsQuery,
  type ScheduleQuery,
} from "./publicApi";
import { usePublicResource, type PublicResource } from "./usePublicResource";

type OfflineControls = { signal?: AbortSignal };

function useOfflineResource<T, Q>(
  fetcher: (options: Q & OfflineControls) => Promise<ResourceLoadResult<T>>,
  query: Q,
  key: string
): PublicResource<T> {
  return usePublicResource((controls) => fetcher({ ...query, ...controls }), key);
}

/** Tracks the configured campus date and refreshes at its next local-day boundary. */
function useCampusDate(timeZone = getInstitutionTimeZone()): string {
  const [currentInstant, setCurrentInstant] = useState(() => new Date());

  useEffect(() => {
/** Advances the local clock state so date-scoped queries refresh at campus midnight. */
    const refreshDate = () => setCurrentInstant(new Date());
    let timeout: ReturnType<typeof setTimeout>;
/** Schedules the next campus-day rollover and recursively re-arms the timer. */
    const scheduleNextRefresh = () => {
      const now = new Date();
      timeout = setTimeout(() => {
        refreshDate();
        scheduleNextRefresh();
      }, millisecondsUntilNextCampusDay(now, timeZone));
    };
    refreshDate();
    scheduleNextRefresh();
    return () => clearTimeout(timeout);
  }, [timeZone]);

  return getCampusDate(currentInstant, timeZone);
}

/** Loads the campus-local Today summary and refreshes its date boundary at midnight. */
export function useToday(): PublicResource<TodayResponse> {
  const campusDate = useCampusDate();
  return useOfflineResource<TodayResponse, { date: string }>(fetchToday, { date: campusDate }, campusDate);
}

export function useEvents(filter: EventsQuery = {}) {
  return useOfflineResource<EventsResponse, EventsQuery>(fetchEvents, filter, JSON.stringify(filter));
}

export function useRooms(options: RoomsQuery = {}) {
  return useOfflineResource<RoomsResponse, RoomsQuery>(fetchRooms, options, JSON.stringify(options));
}

export function useSchedule(options: ScheduleQuery = {}) {
  return useOfflineResource<ScheduleResponse, ScheduleQuery>(fetchSchedule, options, JSON.stringify(options));
}
