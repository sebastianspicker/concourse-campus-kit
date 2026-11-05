/** Preflights the number of eligible recurring ICS events before expansion. */

import { parseIcsDate } from "./recurrenceDate";
import { isRecurrenceEligible, type RecurrencePreflightOptions } from "./recurrenceRules";
import { forEachValidIcsEvent, type EventAccumulator } from "./icsEventStream";

type CountOptions = Omit<RecurrencePreflightOptions, "dtStart"> & { timeZone?: string };

/** Counts recurrence candidates that can pass preflight, zoning dates exactly as the parse pass does. */
export function countRecurringEvents(ics: string, options: CountOptions): number {
  const { timeZone, ...preflight } = options;
  let count = 0;
  forEachValidIcsEvent(ics, (event) => {
    if (isCountableRecurring(event, preflight)) count += 1;
  }, timeZone);
  return count;
}

function isCountableRecurring(event: EventAccumulator, options: Omit<RecurrencePreflightOptions, "dtStart">): boolean {
  const summary = event.current.SUMMARY?.value.trim();
  const start = event.current.DTSTART;
  const rule = event.current.RRULE?.value.trim();
  if (!summary || !start?.value.trim() || !rule) return false;
  try {
    parseIcsDate(start.value.trim(), start.params.TZID);
    const end = event.current.DTEND;
    if (end?.value) parseIcsDate(end.value, end.params.TZID);
    return isRecurrenceEligible(rule, { ...options, dtStart: start });
  } catch { return false; }
}
