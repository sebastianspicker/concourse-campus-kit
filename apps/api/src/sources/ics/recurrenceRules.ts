import { createHash } from "node:crypto";
import { RRule, RRuleSet, rrulestr } from "rrule";
import {
  floatingDateFromIcsValue,
  floatingDateToInstant,
  instantToFloatingDate,
  parseIcsDate,
  recurrenceTimeZone
} from "./recurrenceDate";

export type ParsedIcsEvent = {
  id: string;
  title: string;
  startsAt: string;
  endsAt?: string;
  location?: string;
  campusId?: string;
  description?: string;
  isRecurring?: boolean;
  recurringInstanceId?: string;
};

export type IcsDateProperty = { value: string; params: Record<string, string> };
export type RecurrenceWorkBudget = { remaining: number };

export type RecurrenceExpansionOptions = {
  dtStart: IcsDateProperty;
  exdates: IcsDateProperty[];
  horizonDays: number;
  maxInstances: number;
  referenceDate: Date;
  workBudget: RecurrenceWorkBudget;
};

export type RecurrencePreflightOptions = Pick<RecurrenceExpansionOptions, "dtStart" | "horizonDays" | "maxInstances" | "referenceDate">;

const RRULE_PREFIX = "RRULE:";
const ALL_DAY_VALUE_PATTERN = /^\d{8}$/;
const EXPLICIT_BY_RULE_PART = /(?:^|;)BY[A-Z]+=/i;
const UTC_UNTIL_PATTERN = /(?:^|;)UNTIL=[^;]+Z(?:;|$)/i;
const MAX_RRULE_WORK_PER_EVENT = 10_000;
const UNSUPPORTED_RECURRENCE = -1;
const SAFE_RRULE_KEYS = new Set(["FREQ", "COUNT", "UNTIL", "INTERVAL", "WKST", "BYDAY", "BYHOUR", "BYMINUTE", "BYSECOND"]);
const UNNUMBERED_WEEKDAYS = /^(?:MO|TU|WE|TH|FR|SA|SU)(?:,(?:MO|TU|WE|TH|FR|SA|SU))*$/i;
const FREQUENCY_MILLISECONDS = [
  31_536_000_000,
  2_419_200_000,
  604_800_000,
  86_400_000,
  3_600_000,
  60_000,
  1000
];

/** Saturates a work-product estimate just above the per-event recurrence budget. */
function cappedWork(first: number, second: number): number {
  if (first === 0 || second === 0) return 0;
  return first > MAX_RRULE_WORK_PER_EVENT / second ? MAX_RRULE_WORK_PER_EVENT + 1 : first * second;
}

/** Estimates combinatorial BY-rule fan-out before recurrence expansion begins. */
function explicitByValueMultiplier(rruleValue: string): number {
  return rruleValue.replace(/^RRULE:/i, "").split(";").reduce((multiplier, part) => {
    if (!part.match(/^BY[A-Z]+=/i)) return multiplier;
    const valueCount = part.split("=", 2)[1]?.split(",").filter(Boolean).length ?? 0;
    return cappedWork(multiplier, Math.max(1, valueCount));
  }, 1);
}

/** Returns the fixed interval duration used for supported recurrence frequencies. */
function frequencyMilliseconds(frequency: number): number {
  return FREQUENCY_MILLISECONDS[frequency] ?? 1000;
}

/** Estimates elapsed recurrence steps to bound work skipped before the window. */
function recurrenceStepsBetween(start: Date, end: Date, rrule: RRule): number {
  if (end <= start) return 0;
  return Math.ceil((end.getTime() - start.getTime()) / frequencyMilliseconds(rrule.options.freq) / Math.max(1, rrule.options.interval));
}

/** Accepts only finite declared COUNT values that fit the expansion policy. */
function isSupportedCount(declaredCount: number | null): boolean {
  if (declaredCount === null) return true;
  return Number.isSafeInteger(declaredCount) && declaredCount >= 0 && declaredCount <= MAX_RRULE_WORK_PER_EVENT;
}

type RecurrenceWorkInput = {
  rrule: RRule;
  rruleValue: string;
  startDate: Date;
  fromDate: Date;
  horizonDate: Date;
  maxInstances: number;
  includePast: boolean;
  budget: RecurrenceWorkBudget;
};

/** Estimates future generated instances while accounting for rule fan-out and COUNT. */
function futureRecurrenceWork(input: RecurrenceWorkInput, multiplier: number, declaredCount: number | null): number {
  if (EXPLICIT_BY_RULE_PART.test(input.rruleValue)) {
    return cappedWork(recurrenceStepsBetween(input.fromDate, input.horizonDate, input.rrule), multiplier);
  }
  return Math.min(input.maxInstances, declaredCount ?? input.maxInstances);
}

/** Limits past-instance scanning so historical series cannot consume unbounded work. */
function recurrencePastLimit(includePast: boolean, declaredCount: number | null, priorWork: number): number {
  if (!includePast) return 0;
  return Math.min(declaredCount ?? priorWork + 1, MAX_RRULE_WORK_PER_EVENT);
}

/** Checks and reserves shared recurrence work before a costly expansion step. */
function canSpendRecurrenceWork(work: number, budget: RecurrenceWorkBudget): boolean {
  return work <= Math.min(MAX_RRULE_WORK_PER_EVENT, budget.remaining);
}

/** Derives the bounded number of pre-window candidates worth inspecting. */
function pastCandidateLimit(input: RecurrenceWorkInput): number {
  const { rrule, rruleValue, startDate, fromDate, includePast, budget } = input;
  const declaredCount = rrule.options.count;
  const multiplier = explicitByValueMultiplier(rruleValue);
  const priorWork = cappedWork(recurrenceStepsBetween(startDate, fromDate, rrule), multiplier);
  const futureWork = futureRecurrenceWork(input, multiplier, declaredCount);
  const pastLimit = recurrencePastLimit(includePast, declaredCount, priorWork);
  const estimatedWork = Math.max(1, priorWork + futureWork + pastLimit);
  if (!canSpendRecurrenceWork(estimatedWork, budget)) return UNSUPPORTED_RECURRENCE;
  budget.remaining -= estimatedWork;
  return pastLimit;
}

type ExdateParseInput = {
  properties: IcsDateProperty[];
  recurrenceZone?: string;
};

/** Parses EXDATE values into excluded instants using their declared property zones. */
function parseExdates(input: ExdateParseInput): Date[] {
  return input.properties.flatMap((property) => property.value.split(",").flatMap((part) => {
    try {
      const instant = new Date(parseIcsDate(part.trim(), property.params.TZID ?? input.recurrenceZone));
      return input.recurrenceZone ? [instantToFloatingDate(instant, input.recurrenceZone)] : [instant];
    } catch {
      return [];
    }
  }));
}

type RuleParseInput = {
  ruleValue: string;
  startDate: Date;
  timeZone?: string;
};

/** Rejects rule sets and adjusts UTC UNTIL values for floating-zone evaluation. */
function parseRule(input: RuleParseInput): RRule {
  const ruleString = input.ruleValue.startsWith(RRULE_PREFIX) ? input.ruleValue : `${RRULE_PREFIX}${input.ruleValue}`;
  const parsed = rrulestr(ruleString, { dtstart: input.startDate, tzid: null });
  if (parsed instanceof RRuleSet) throw new Error("Unsupported recurrence rule set");
  if (!hasBoundedSearch(input.ruleValue, parsed)) throw new Error("Unsupported recurrence rule");
  if (!input.timeZone || !parsed.options.until || !UTC_UNTIL_PATTERN.test(input.ruleValue)) return parsed;
  return new RRule({
    ...parsed.origOptions,
    dtstart: input.startDate,
    until: instantToFloatingDate(parsed.options.until, input.timeZone),
    tzid: null
  });
}

/** Accepts only recurrence grammar whose iterator is guaranteed to emit or advance to its horizon. */
function hasBoundedSearch(ruleValue: string, rule: RRule): boolean {
  const clauses = parseRuleClauses(ruleValue);
  if (!clauses) return false;
  const { freq, interval } = rule.options;
  return [
    hasValidRecurrenceScalars(rule),
    hasSupportedByDay(clauses.get("BYDAY"), freq, interval),
    hasSupportedNumberFilter(clauses, "BYHOUR", freq, RRule.DAILY, 23),
    hasSupportedNumberFilter(clauses, "BYMINUTE", freq, RRule.HOURLY, 59),
    hasSupportedNumberFilter(clauses, "BYSECOND", freq, RRule.MINUTELY, 59)
  ].every(Boolean);
}

function hasSupportedByDay(value: string | undefined, frequency: number, interval: number): boolean {
  if (value === undefined) return true;
  if (!UNNUMBERED_WEEKDAYS.test(value) || frequency > RRule.DAILY) return false;
  return frequency !== RRule.DAILY || interval === 1;
}

function hasSupportedNumberFilter(
  clauses: Map<string, string>,
  key: string,
  frequency: number,
  maximumFrequency: number,
  maximumValue: number
): boolean {
  if (!clauses.has(key)) return true;
  if (frequency > maximumFrequency) return false;
  return isNumberListInRange(clauses.get(key), 0, maximumValue);
}

function parseRuleClauses(ruleValue: string): Map<string, string> | null {
  const clauses = new Map<string, string>();
  for (const clause of ruleValue.replace(/^RRULE:/i, "").split(";")) {
    const separator = clause.indexOf("=");
    const key = clause.slice(0, separator).toUpperCase();
    const value = clause.slice(separator + 1);
    if (separator < 1 || !value || !SAFE_RRULE_KEYS.has(key) || clauses.has(key)) return null;
    clauses.set(key, value);
  }
  return clauses;
}

function hasValidRecurrenceScalars(rule: RRule): boolean {
  const { count, freq, interval, until } = rule.options;
  return [
    isSupportedFrequency(freq),
    Number.isSafeInteger(interval) && interval > 0,
    isSupportedCount(count),
    until === null || Number.isFinite(until.getTime())
  ].every(Boolean);
}

function isSupportedFrequency(frequency: number): boolean {
  return Number.isSafeInteger(frequency) && frequency >= RRule.YEARLY && frequency <= RRule.SECONDLY;
}

function isNumberListInRange(value: string | undefined, minimum: number, maximum: number): boolean {
  if (value === undefined) return true;
  return value.split(",").every((part) => {
    const parsed = Number(part);
    return /^\d+$/.test(part) && Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum;
  });
}

/** Returns the base event unchanged when recurrence expansion cannot proceed safely. */
function fallback(baseEvent: ParsedIcsEvent, exdates: Date[], recurrenceStart: Date): ParsedIcsEvent[] {
  return exdates.some((exdate) => exdate.getTime() === recurrenceStart.getTime()) ? [] : [baseEvent];
}

/** Applies exception dates to the parsed rule before enumerating occurrences. */
function occurrenceSource(rule: RRule, exdates: Date[]): RRule {
  if (exdates.length === 0) return rule;
  const set = new RRuleSet();
  set.rrule(rule);
  exdates.forEach((exdate) => set.exdate(exdate));
  return set;
}

type OccurrenceWindow = {
  source: RRule;
  startDate: Date;
  referenceDate: Date;
  horizonDate: Date;
  maxInstances: number;
  includePast: boolean;
  pastLimit: number;
};

/** Enumerates occurrences only inside the precomputed bounded recurrence window. */
function expandOccurrences(window: OccurrenceWindow): Date[] {
  const { source, startDate, referenceDate, horizonDate, maxInstances, includePast, pastLimit } = window;
  const upcoming = startDate <= horizonDate && referenceDate <= horizonDate
    ? source.between(startDate > referenceDate ? startDate : referenceDate, horizonDate, true, (_occurrence, index) => index < maxInstances)
    : [];
  if (!includePast || upcoming.length >= maxInstances) return upcoming;
  const past = source.between(startDate, referenceDate, true, (_occurrence, index) => index < pastLimit)
    .filter((occurrence) => occurrence < referenceDate);
  return upcoming.concat(past.slice(-(maxInstances - upcoming.length)));
}

/** Derives a stable identifier for one expanded occurrence from its start instant. */
export function instanceId(baseId: string, startsAt: string): string {
  // The base id remains stable while every expanded occurrence gets an
  // independently routable key; RECURRENCE-ID overrides reuse it for their slot.
  return createHash("sha256").update(`${baseId}|${startsAt}`).digest("hex").slice(0, 16);
}

/** Measures a duration on the zone's wall clock, so a day-long entry stays a calendar day across DST. */
function wallClockDuration(baseEvent: ParsedIcsEvent, timeZone?: string): number {
  if (!baseEvent.endsAt) return 0;
  const [start, end] = [new Date(baseEvent.startsAt), new Date(baseEvent.endsAt)];
  return timeZone
    ? instantToFloatingDate(end, timeZone).getTime() - instantToFloatingDate(start, timeZone).getTime()
    : end.getTime() - start.getTime();
}

/** Ends an occurrence after the base duration, applied to its wall-clock start when the series is zoned. */
function occurrenceEnd(occurrence: Date, instant: Date, duration: number, timeZone?: string): string {
  const end = timeZone ? floatingDateToInstant(new Date(occurrence.getTime() + duration), timeZone) : new Date(instant.getTime() + duration);
  return end.toISOString();
}

/** Maps recurrence instants to event copies; all-day series keep calendar-day durations, timed ones exact durations (RFC 5545). */
function mapOccurrences(baseEvent: ParsedIcsEvent, occurrences: Date[], timeZone: string | undefined, allDay: boolean): ParsedIcsEvent[] {
  const durationZone = allDay ? timeZone : undefined;
  const duration = wallClockDuration(baseEvent, durationZone);
  return occurrences.sort((a, b) => a.getTime() - b.getTime()).map((occurrence) => {
    const instant = timeZone ? floatingDateToInstant(occurrence, timeZone) : occurrence;
    const startsAt = instant.toISOString();
    const recurringInstanceId = instanceId(baseEvent.id, startsAt);
    return {
      ...baseEvent,
      id: recurringInstanceId,
      startsAt,
      endsAt: duration > 0 ? occurrenceEnd(occurrence, instant, duration, durationZone) : baseEvent.endsAt,
      isRecurring: true,
      recurringInstanceId
    };
  });
}

type RecurrenceWindowContext = {
  timeZone?: string;
  startDate: Date;
  referenceDate: Date;
  horizonDate: Date;
};

/** Precomputes the horizon and work limits shared by recurrence preflight and expansion. */
function recurrenceWindowContext(options: RecurrencePreflightOptions): RecurrenceWindowContext {
  const timeZone = recurrenceTimeZone(options.dtStart);
  const startDate = timeZone
    ? floatingDateFromIcsValue(options.dtStart.value)
    : new Date(parseIcsDate(options.dtStart.value, options.dtStart.params.TZID));
  const horizon = new Date(options.referenceDate.getTime() + options.horizonDays * 86_400_000);
  return {
    timeZone,
    startDate,
    referenceDate: timeZone ? instantToFloatingDate(options.referenceDate, timeZone) : options.referenceDate,
    horizonDate: timeZone ? instantToFloatingDate(horizon, timeZone) : horizon
  };
}

/** Checks whether a recurrence can be safely expanded within the supplied limits. */
export function isRecurrenceEligible(ruleValue: string, options: RecurrencePreflightOptions): boolean {
  if (options.maxInstances === 0) return true;
  try {
    const window = recurrenceWindowContext(options);
    const rule = parseRule({ ruleValue, startDate: window.startDate, timeZone: window.timeZone });
    if (!isSupportedCount(rule.options.count)) return false;
    const limit = pastCandidateLimit({
      rrule: rule,
      rruleValue: ruleValue,
      startDate: window.startDate,
      fromDate: window.startDate > window.referenceDate ? window.startDate : window.referenceDate,
      horizonDate: window.horizonDate,
      maxInstances: options.maxInstances,
      includePast: rule.options.count != null || rule.options.until != null,
      budget: { remaining: MAX_RRULE_WORK_PER_EVENT }
    });
    return limit !== UNSUPPORTED_RECURRENCE;
  } catch { return false; }
}

/** Expands a recurrence without exceeding horizon, instance, or shared work budgets. */
export function expandRecurringEvent(baseEvent: ParsedIcsEvent, ruleValue: string, options: RecurrenceExpansionOptions): ParsedIcsEvent[] {
  if (options.maxInstances === 0) return [];
  let startDate = new Date(baseEvent.startsAt);
  let exdates: Date[] = [];
  try {
    const window = recurrenceWindowContext(options);
    startDate = window.startDate;
    exdates = parseExdates({ properties: options.exdates, recurrenceZone: window.timeZone });
    const rule = parseRule({ ruleValue, startDate, timeZone: window.timeZone });
    if (!isSupportedCount(rule.options.count)) return fallback(baseEvent, exdates, startDate);

    const includePast = rule.options.count != null || rule.options.until != null;
    const fromDate = startDate > window.referenceDate ? startDate : window.referenceDate;
    const limit = pastCandidateLimit({
      rrule: rule,
      rruleValue: ruleValue,
      startDate,
      fromDate,
      horizonDate: window.horizonDate,
      maxInstances: options.maxInstances,
      includePast,
      budget: options.workBudget
    });
    if (limit === UNSUPPORTED_RECURRENCE) return fallback(baseEvent, exdates, startDate);
    return mapOccurrences(
      baseEvent,
      expandOccurrences({
        source: occurrenceSource(rule, exdates),
        startDate,
        referenceDate: window.referenceDate,
        horizonDate: window.horizonDate,
        maxInstances: options.maxInstances,
        includePast,
        pastLimit: limit
      }),
      window.timeZone,
      ALL_DAY_VALUE_PATTERN.test(options.dtStart.value.trim())
    );
  } catch {
    return fallback(baseEvent, exdates, startDate);
  }
}
