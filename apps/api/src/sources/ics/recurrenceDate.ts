import {
  getDateTimePartsInTimeZone,
  parseDateTimeInTimeZone,
  utcDateFromParts
} from "../time";

const ICS_DATE_TIME_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z|[+-]\d{4}|[+-]\d{2}:\d{2})?$/;
const FLOATING_DATE_TIME_PATTERN = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?$/;

export type CalendarParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

type IcsDateTimeValues = {
  year: string;
  month: string;
  day: string;
  hour?: string;
  minute?: string;
  second?: string;
};

type IcsDateTimeResolution = {
  dateTime: string;
  parts: CalendarParts;
  suffix: string | undefined;
  timeZone: string | undefined;
  originalValue: string;
};

/** Rejects a timestamp string that the JavaScript date parser cannot represent. */
function validIsoDate(dateValue: string, originalValue: string): string {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ICS date: ${originalValue}`);
  return date.toISOString();
}

/** Serializes every calendar and clock field for recurrence local-time comparisons. */
function calendarPartsKey(parts: CalendarParts): string {
  return [parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second].join(":");
}

/** Rejects impossible month, day, hour, minute, or second values before conversion. */
function validateDateParts(parts: CalendarParts): void {
  const candidate = utcDateFromParts(parts);
  const normalized: CalendarParts = {
    year: candidate.getUTCFullYear(),
    month: candidate.getUTCMonth() + 1,
    day: candidate.getUTCDate(),
    hour: candidate.getUTCHours(),
    minute: candidate.getUTCMinutes(),
    second: candidate.getUTCSeconds()
  };
  const values = [parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second];
  if (!values.every(Number.isInteger) || calendarPartsKey(normalized) !== calendarPartsKey(parts)) {
    throw new Error("Invalid calendar datetime");
  }
}

/** Converts numeric ICS date fields into a calendar value for validation and conversion. */
function calendarPartsFromIcsValues(values: IcsDateTimeValues): CalendarParts {
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour ?? "00"),
    minute: Number(values.minute ?? "00"),
    second: Number(values.second ?? "00")
  };
}

/** Parses an all-day ICS value as local midnight in its zone, or UTC midnight without one. */
function parseAllDayIcsDate(value: string, timeZone: string | undefined): string | undefined {
  if (!/^\d{8}$/.test(value)) return undefined;
  const [year, month, day] = [value.slice(0, 4), value.slice(4, 6), value.slice(6, 8)];
  const parts = calendarPartsFromIcsValues({ year, month, day });
  validateDateParts(parts);
  if (timeZone) return parseDateTimeInTimeZone(parts, timeZone);
  return validIsoDate(`${year}-${month}-${day}T00:00:00.000Z`, value);
}

/** Normalizes RFC offset text into the form accepted by the date parser. */
function normalizeOffset(suffix: string): string {
  return suffix.includes(":") ? suffix : `${suffix.slice(0, 3)}:${suffix.slice(3)}`;
}

/** Resolves a validated ICS clock value according to its suffix or declared zone. */
function resolveIcsDateTime(resolution: IcsDateTimeResolution): string {
  const { dateTime, parts, suffix, timeZone, originalValue } = resolution;
  if (suffix === "Z") return validIsoDate(`${dateTime}.000Z`, originalValue);
  if (suffix) return validIsoDate(`${dateTime}${normalizeOffset(suffix)}`, originalValue);
  if (timeZone) return parseDateTimeInTimeZone(parts, timeZone);
  return validIsoDate(`${dateTime}.000Z`, originalValue);
}

/** Converts an ICS date or timestamp to an ISO instant, validating calendar values first. */
export function parseIcsDate(value: string, timeZone?: string): string {
  const allDayDate = parseAllDayIcsDate(value, timeZone);
  if (allDayDate) return allDayDate;

  const match = value.match(ICS_DATE_TIME_PATTERN);
  if (!match) throw new Error(`Invalid ICS date: ${value}`);

  const year = match[1];
  const month = match[2];
  const day = match[3];
  const hour = match[4];
  const minute = match[5];
  const second = match[6] ?? "00";
  const suffix = match[7];
  const parts = calendarPartsFromIcsValues({ year, month, day, hour, minute, second });
  validateDateParts(parts);
  return resolveIcsDateTime({
    dateTime: `${year}-${month}-${day}T${hour}:${minute}:${second}`,
    parts,
    suffix,
    timeZone,
    originalValue: value
  });
}

/** Parses a floating ICS timestamp or date without applying a time-zone offset. */
export function floatingDateFromIcsValue(value: string): Date {
  const match = value.match(FLOATING_DATE_TIME_PATTERN);
  if (!match) throw new Error(`Invalid floating ICS date: ${value}`);
  const [, year, month, day, hour, minute, second = "00"] = match;
  return utcDateFromParts(calendarPartsFromIcsValues({ year, month, day, hour, minute, second }));
}

/** Expresses an instant as a floating local clock value in the recurrence zone. */
export function instantToFloatingDate(instant: Date, timeZone: string): Date {
  const parts = getDateTimePartsInTimeZone(instant, timeZone);
  const floating = utcDateFromParts(parts);
  floating.setUTCMilliseconds(instant.getUTCMilliseconds());
  return floating;
}

/** Interprets a floating recurrence clock value in its declared time zone. */
export function floatingDateToInstant(floating: Date, timeZone: string): Date {
  return new Date(parseDateTimeInTimeZone({
    year: floating.getUTCFullYear(), month: floating.getUTCMonth() + 1, day: floating.getUTCDate(),
    hour: floating.getUTCHours(), minute: floating.getUTCMinutes(), second: floating.getUTCSeconds()
  }, timeZone));
}

/** Selects the DTSTART zone that preserves the series local wall-clock time. */
export function recurrenceTimeZone(dtStart: { value: string; params: Record<string, string> }): string | undefined {
  const timeZone = dtStart.params.TZID;
  return timeZone && FLOATING_DATE_TIME_PATTERN.test(dtStart.value) ? timeZone : undefined;
}
