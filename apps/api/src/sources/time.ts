export type DateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export function utcDateFromParts(parts: DateTimeParts): Date {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, 0);
  return date;
}

// Zone names come from untrusted feeds; cap the cache so distinct spellings of valid zones cannot grow it.
const MAX_CACHED_FORMATTERS = 64;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric"
  });
  if (formatterCache.size < MAX_CACHED_FORMATTERS) formatterCache.set(timeZone, formatter);
  return formatter;
}

const MAX_REMEMBERED_UNKNOWN_TIME_ZONES = 256;
const unknownTimeZones = new Set<string>();

/** Reports whether Intl accepts a zone name, remembering rejections so repeated feed TZIDs throw only once. */
export function isKnownTimeZone(timeZone: string): boolean {
  if (unknownTimeZones.has(timeZone)) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    if (unknownTimeZones.size < MAX_REMEMBERED_UNKNOWN_TIME_ZONES) unknownTimeZones.add(timeZone);
    return false;
  }
}

function getZonedDateTimeParts(date: Date, timeZone: string): DateTimeParts {
  const parts = formatterFor(timeZone).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second")
  };
}

export function getDateTimePartsInTimeZone(date: Date, timeZone: string): DateTimeParts {
  return getZonedDateTimeParts(date, timeZone);
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = getDateTimePartsInTimeZone(date, timeZone);
  const asUtc = utcDateFromParts(parts).getTime();
  return asUtc - date.getTime();
}

/** Parses an ICS-style wall-clock timestamp in its declared IANA zone. */
export function parseDateTimeInTimeZone(
  parts: DateTimeParts,
  timeZone: string
): string {
  const targetWallTime = validatedUtcMillisecondsFromParts(parts);
  const candidates = getLocalTimeCandidates(targetWallTime, timeZone);
  const exactMatches = candidates
    .filter((candidate) => candidate.wallTime === targetWallTime)
    .sort((first, second) => first.instant - second.instant);

  if (exactMatches.length > 0) {
    // RFC 5545 requires the first occurrence when a local time is repeated
    // during a backward offset transition.
    return new Date(exactMatches[0].instant).toISOString();
  }

  const postGapCandidates = candidates
    .filter((candidate) => candidate.wallTime > targetWallTime)
    .sort((first, second) => first.wallTime - second.wallTime);
  if (postGapCandidates.length > 0) {
    // For a local time skipped by a forward transition, RFC 5545 applies the
    // offset from before the gap. That candidate is the nearest wall time
    // after the requested one.
    return new Date(postGapCandidates[0].instant).toISOString();
  }

  throw new Error(`Invalid ${timeZone} local datetime`);
}

const OFFSET_PROBE_WINDOW_MS = 48 * 60 * 60 * 1000;

type LocalTimeCandidate = {
  instant: number;
  wallTime: number;
};

function getLocalTimeCandidates(targetWallTime: number, timeZone: string): LocalTimeCandidate[] {
  const offsets = new Set<number>();
  for (const delta of [-OFFSET_PROBE_WINDOW_MS, 0, OFFSET_PROBE_WINDOW_MS]) {
    offsets.add(getTimeZoneOffsetMs(new Date(targetWallTime + delta), timeZone));
  }

  return [...offsets].map((offset) => {
    const instant = targetWallTime - offset;
    return {
      instant,
      wallTime: utcDateFromParts(getDateTimePartsInTimeZone(new Date(instant), timeZone)).getTime()
    };
  });
}

function comparableParts(parts: DateTimeParts): string {
  return [
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  ].join(":");
}

function validatedUtcMillisecondsFromParts(parts: DateTimeParts): number {
  const values = [parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second];
  const date = utcDateFromParts(parts);
  const normalized: DateTimeParts = {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds()
  };
  if (!values.every(Number.isInteger) || Number.isNaN(date.getTime()) || comparableParts(normalized) !== comparableParts(parts)) {
    throw new Error("Invalid calendar datetime");
  }
  return date.getTime();
}
