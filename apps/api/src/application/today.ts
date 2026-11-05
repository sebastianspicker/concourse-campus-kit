import type { TodayResponse } from "@concourse/contracts";
import type { InstitutionPack } from "@concourse/institutions";
import { getCampusDateKey } from "./campusDate";
import { InvalidQueryParameterError, NoConfiguredSourcesError } from "./errors";
import type { PublicDataSources, PublicEventsSourceResult } from "./publicSources";

const EMPTY_EVENTS_RESULT: PublicEventsSourceResult = { events: [], degraded: false };

function isValidDateParam(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() + 1 === Number(match[2]) && date.getUTCDate() === Number(match[3]);
}

function hasConfiguredTodaySources(institution: InstitutionPack): boolean {
  return (institution.publicSources?.events?.length ?? 0) > 0 || (institution.publicRooms?.length ?? 0) > 0;
}

async function loadTodayEvents(institution: InstitutionPack, sources: PublicDataSources): Promise<PublicEventsSourceResult> {
  return (institution.publicSources?.events?.length ?? 0) > 0 ? sources.fetchEvents(institution) : EMPTY_EVENTS_RESULT;
}

function resolveTodayDate(clientDate: string | undefined, timeZone: string, now: Date): string {
  if (clientDate !== undefined) {
    if (isValidDateParam(clientDate)) return clientDate;
    throw new InvalidQueryParameterError("date must be a valid YYYY-MM-DD calendar date");
  }
  return getCampusDateKey(now, timeZone);
}

function filterEventsForDate(events: TodayResponse["events"], today: string, timeZone: string): TodayResponse["events"] {
  return events.filter((event) => {
    try { return getCampusDateKey(event.date, timeZone) === today; } catch { return false; }
  });
}

export async function getToday(institution: InstitutionPack, date: string | undefined, sources: PublicDataSources, now = new Date()): Promise<TodayResponse> {
  if (!hasConfiguredTodaySources(institution)) throw new NoConfiguredSourcesError("No event or room sources configured for today view");
  const timeZone = institution.timezone;
  const today = resolveTodayDate(date, timeZone, now);
  const { events, degraded } = await loadTodayEvents(institution, sources);
  return { events: filterEventsForDate(events, today, timeZone), rooms: institution.publicRooms ?? [], _degraded: degraded, _sourcesConfigured: true };
}
