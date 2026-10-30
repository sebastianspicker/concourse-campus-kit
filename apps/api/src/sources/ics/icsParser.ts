/** Parses public ICS calendars with bounded recurrence expansion. */

import { createHash } from "node:crypto";
import {
  SCHEDULE_CAMPUS_ID_MAX_LENGTH,
  SCHEDULE_DESCRIPTION_MAX_LENGTH,
  SCHEDULE_ID_MAX_LENGTH,
  SCHEDULE_LOCATION_MAX_LENGTH,
  SCHEDULE_TITLE_MAX_LENGTH
} from "@concourse/contracts";
import { parseIcsDate } from "./recurrenceDate";
import { expandRecurringEvent, type IcsDateProperty, type ParsedIcsEvent } from "./recurrenceRules";
import { forEachValidIcsEvent, type IcsPropertyMap } from "./icsEventStream";
import { countRecurringEvents } from "./icsRecurrenceCounter";

export type { ParsedIcsEvent } from "./recurrenceRules";

const DEFAULT_RRULE_HORIZON_DAYS = 90;
const DEFAULT_RRULE_MAX_INSTANCES = 100;
const DEFAULT_MAX_TOTAL_EVENTS = 1000;
const MAX_RRULE_WORK_PER_DOCUMENT = 50_000;
const DIRECT_RRULE_PROPERTY_PATTERN = /(?:^|[\r\n])RRULE[;:]/i;
const ICS_FOLD_PATTERN = /[\r\n][ \t]/;

/** Retains a valid UTF-16 prefix that also satisfies the shared wire-schema length limit. */
const truncateScheduleText = (value: string, maximumLength: number): string => {
  const truncated = value.slice(0, maximumLength);
  const finalCodeUnit = truncated.charCodeAt(truncated.length - 1);
  return finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF ? truncated.slice(0, -1) : truncated;
};

/** Decodes and bounds untrusted ICS text before it can be copied into recurrence instances. */
const normalizeScheduleText = (value: string, maximumLength: number): string =>
  truncateScheduleText(unescapeIcsValue(value.trim()), maximumLength);

/** Hashes source-independent fields when an ICS event omits a UID. */
const generateStableId = (title: string, startsAt: string): string => {
  return createHash("sha256").update(`${title}|${startsAt}`).digest("hex").slice(0, 16);
}

/** Converts validated VEVENT fields into one base event before recurrence expansion. */
const buildBaseEvent = (current: IcsPropertyMap, summary: string, dtStart: string): ParsedIcsEvent => {
  const startsAt = parseIcsDate(dtStart, current.DTSTART?.params.TZID);
  const title = normalizeScheduleText(summary, SCHEDULE_TITLE_MAX_LENGTH);
  const uid = current.UID?.value ? normalizeScheduleText(current.UID.value, SCHEDULE_ID_MAX_LENGTH) : undefined;
  return {
    id: uid || generateStableId(title, startsAt), title, startsAt,
    endsAt: current.DTEND?.value ? parseIcsDate(current.DTEND.value, current.DTEND.params.TZID) : undefined,
    location: current.LOCATION?.value ? normalizeScheduleText(current.LOCATION.value, SCHEDULE_LOCATION_MAX_LENGTH) : undefined,
    campusId: current["X-CAMPUS-ID"]?.value
      ? normalizeScheduleText(current["X-CAMPUS-ID"].value, SCHEDULE_CAMPUS_ID_MAX_LENGTH)
      : current["X-CAMPUS"]?.value
        ? normalizeScheduleText(current["X-CAMPUS"].value, SCHEDULE_CAMPUS_ID_MAX_LENGTH)
        : undefined,
    description: current.DESCRIPTION?.value ? normalizeScheduleText(current.DESCRIPTION.value, SCHEDULE_DESCRIPTION_MAX_LENGTH) : undefined
  };
}

/** Prioritizes upcoming events when the parser must retain fewer than it encounters. */
const compareRetentionPriority = (first: ParsedIcsEvent, second: ParsedIcsEvent, referenceTime: number): number => {
  const firstTime = Date.parse(first.startsAt);
  const secondTime = Date.parse(second.startsAt);
  const firstUpcoming = firstTime >= referenceTime;
  const secondUpcoming = secondTime >= referenceTime;
  if (firstUpcoming !== secondUpcoming) return firstUpcoming ? -1 : 1;
  if (firstTime !== secondTime) return firstUpcoming ? firstTime - secondTime : secondTime - firstTime;
  return first.id.localeCompare(second.id) || first.title.localeCompare(second.title);
}

/** Retains only the highest-priority events when the document output cap is reached. */
const insertRelevantEvent = (events: ParsedIcsEvent[], event: ParsedIcsEvent, maxTotal: number, referenceTime: number): void => {
  if (events.length === maxTotal && compareRetentionPriority(event, events[events.length - 1], referenceTime) >= 0) return;
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareRetentionPriority(event, events[middle], referenceTime) < 0) high = middle;
    else low = middle + 1;
  }
  events.splice(low, 0, event);
  if (events.length > maxTotal) events.pop();
}

const compareChronologically = (first: ParsedIcsEvent, second: ParsedIcsEvent): number => {
  return first.startsAt.localeCompare(second.startsAt) || first.id.localeCompare(second.id);
}

/** Keeps the most relevant events (upcoming first) up to maxTotal, in chronological order. */
export function retainRelevantEvents(events: ParsedIcsEvent[], maxTotal: number, referenceDate = new Date()): ParsedIcsEvent[] {
  const retained: ParsedIcsEvent[] = [];
  events.forEach((event) => insertRelevantEvent(retained, event, maxTotal, referenceDate.getTime()));
  return retained.sort(compareChronologically);
}

export interface ParseIcsOptions { rruleHorizonDays?: number; rruleMaxInstances?: number; maxTotalEvents?: number; referenceDate?: Date; }

type ParseContext = {
  horizonDays: number;
  maxTotalEvents: number;
  expansionMaxInstances: number;
  referenceDate: Date;
  recurrenceWorkPerEvent: number;
};

/** Floors caller limits and clamps them to a non-negative parser safety maximum. */
const bounded = (value: number | undefined, fallback: number, maximum: number): number => {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.min(maximum, Math.max(0, Math.floor(value)));
}

/** Derives bounded parse and recurrence budgets from caller options and document shape. */
const parseContext = (options: ParseIcsOptions | undefined, recurringCount: number): ParseContext => {
  const referenceDate = options?.referenceDate && !Number.isNaN(options.referenceDate.getTime()) ? new Date(options.referenceDate) : new Date();
  const maxInstances = bounded(options?.rruleMaxInstances, DEFAULT_RRULE_MAX_INSTANCES, DEFAULT_RRULE_MAX_INSTANCES);
  const maxTotalEvents = bounded(options?.maxTotalEvents, DEFAULT_MAX_TOTAL_EVENTS, DEFAULT_MAX_TOTAL_EVENTS);
  return {
    horizonDays: bounded(options?.rruleHorizonDays, DEFAULT_RRULE_HORIZON_DAYS, 366),
    maxTotalEvents,
    expansionMaxInstances: Math.min(maxInstances, maxTotalEvents),
    referenceDate,
    recurrenceWorkPerEvent: recurringCount > 0 ? Math.floor(MAX_RRULE_WORK_PER_DOCUMENT / recurringCount) : 0
  };
}

/** Counts eligible recurrence candidates only when the document contains a plausible RRULE. */
const countDocumentRecurringEvents = (ics: string, context: ParseContext): number => {
  if (!DIRECT_RRULE_PROPERTY_PATTERN.test(ics) && !ICS_FOLD_PATTERN.test(ics)) return 0;
  return countRecurringEvents(ics, {
    referenceDate: context.referenceDate,
    horizonDays: context.horizonDays,
    maxInstances: context.expansionMaxInstances
  });
}

/** Builds one event and expands recurrence only after the document budget permits it. */
const appendEvent = (events: ParsedIcsEvent[], current: IcsPropertyMap, exdates: IcsDateProperty[], context: ParseContext): void => {
  const summary = current.SUMMARY?.value.trim();
  const dtStart = current.DTSTART?.value.trim();
  if (!summary || !dtStart) return;
  try {
    const baseEvent = buildBaseEvent(current, summary, dtStart);
    const rule = current.RRULE?.value.trim();
    const candidates = rule ? expandRecurringEvent(baseEvent, rule, {
      dtStart: current.DTSTART, exdates, horizonDays: context.horizonDays,
      maxInstances: context.expansionMaxInstances, referenceDate: context.referenceDate,
      workBudget: { remaining: context.recurrenceWorkPerEvent }
    }) : [baseEvent];
    candidates.forEach((event) => insertRelevantEvent(events, event, context.maxTotalEvents, context.referenceDate.getTime()));
  } catch { /* Invalid values are isolated to their VEVENT. */ }
}

/** Parses valid VEVENTs while bounding recurrence work and total retained events. */
export function parseIcs(ics: string, options?: ParseIcsOptions): ParsedIcsEvent[] {
  const limits = parseContext(options, 1);
  if (limits.maxTotalEvents === 0) return [];
  const context = parseContext(options, countDocumentRecurringEvents(ics, limits));
  const events: ParsedIcsEvent[] = [];
  forEachValidIcsEvent(ics, (event) => appendEvent(events, event.current, event.exdates, context));
  return events.sort(compareChronologically);
}

/** Decodes ICS text escapes after structural parsing has separated property values. */
const unescapeIcsValue = (value: string): string => {
  return value
    .replaceAll("\\n", "\n")
    .replaceAll("\\N", "\n")
    .replaceAll("\\,", ",")
    .replaceAll("\\;", ";")
    .replaceAll("\\\\", "\\");
}
