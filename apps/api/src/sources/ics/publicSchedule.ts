/** Fetches, parses, caches, and degrades gracefully for public schedule sources. */

import { createHash } from "node:crypto";
import type { InstitutionPack } from "@concourse/institutions";
import { isPublicHttpUrl, SCHEDULE_RESPONSE_MAX_ITEMS, type ScheduleItem } from "@concourse/contracts";
import { log } from "../../runtime/logger";
import { getCached } from "../upstream/cache";
import { getPublicSourceBreaker } from "../upstream/circuitBreaker";
import { fetchTextWithTimeout } from "../upstream/httpClient";
import { parseIcs, retainRelevantEvents, type ParsedIcsEvent } from "./icsParser";

export type FetchPublicScheduleResult = { schedule: ScheduleItem[]; degraded: boolean };
export type PublicScheduleOptions = { cacheTtlMs: number; rruleHorizonDays: number; mode?: string; date?: Date };
type ScheduleSource = { url: string; label: string };
type SettledScheduleSource = PromiseSettledResult<ParsedIcsEvent[]>;

function toScheduleItem(p: ParsedIcsEvent): ScheduleItem {
  return {
    id: p.id,
    title: p.title,
    startsAt: p.startsAt,
    endsAt: p.endsAt,
    location: p.location,
    campusId: p.campusId,
    description: p.description,
  };
}

/** Mock mode is deterministic and offline: one item per configured source, at the mock date, with a stable ID. */
function sourceLabelSchedule(sources: ScheduleSource[], date: Date): ScheduleItem[] {
  const startsAt = date.toISOString();
  return sources.map((source) => ({
    id: `mock_${createHash("sha256").update(JSON.stringify([source.url, source.label])).digest("hex").slice(0, 24)}`,
    title: source.label,
    startsAt
  }));
}

/** Fetches and parses one source through its source-scoped circuit breaker. */
async function loadScheduleSource(source: ScheduleSource, signal: AbortSignal, rruleHorizonDays: number): Promise<ParsedIcsEvent[]> {
  const text = await getPublicSourceBreaker("public-schedule", source.url).call(
    () => fetchTextWithTimeout(source.url, { signal })
  );
  return parseIcs(text, { rruleHorizonDays });
}

/** Logs a failed source and returns no events so successful sources remain usable. */
function eventsFromSettledSource(source: ScheduleSource, result: SettledScheduleSource): ParsedIcsEvent[] {
  if (result.status === "fulfilled") return result.value;

  log("warn", "public_schedule_source_failed", {
    source: source.label,
    reason: "upstream_request_failed"
  });
  return [];
}

/**
 * Combines settled sources chronologically within the wire limit, keeping
 * upcoming occurrences first, and retains partial-data degradation.
 */
function combineScheduleSources(
  sources: ScheduleSource[],
  settledSources: SettledScheduleSource[],
  hasRejectedSource: boolean
): FetchPublicScheduleResult {
  const events = settledSources.flatMap((result, index) =>
    eventsFromSettledSource(sources[index], result)
  );
  const schedule = retainRelevantEvents(events, SCHEDULE_RESPONSE_MAX_ITEMS).map(toScheduleItem);
  const degraded = hasRejectedSource || settledSources.some((result) => result.status === "rejected");
  return { schedule, degraded };
}

/** Fetches configured sources independently while surfacing total upstream failure. */
async function loadScheduleSources(
  sources: ScheduleSource[],
  signal: AbortSignal,
  hasRejectedSource: boolean,
  rruleHorizonDays: number
): Promise<FetchPublicScheduleResult> {
  const settledSources = await Promise.allSettled(
    sources.map((source) => loadScheduleSource(source, signal, rruleHorizonDays))
  );

  if (hasRejectedSource && sources.length === 0) {
    throw new Error("All public schedule sources failed");
  }
  if (settledSources.length > 0 && settledSources.every((result) => result.status === "rejected")) {
    throw new Error("All public schedule sources failed");
  }

  return combineScheduleSources(sources, settledSources, hasRejectedSource);
}

/** Fetches configured ICS sources independently and returns partial data when one fails. */
export async function fetchPublicSchedule(
  institution: InstitutionPack,
  options: PublicScheduleOptions
): Promise<FetchPublicScheduleResult> {
  const configuredSources = institution.publicSources?.schedules ?? [];
  const sources = configuredSources.filter((source): source is ScheduleSource => isPublicHttpUrl(source.url));
  const hasRejectedSource = sources.length !== configuredSources.length;
  const cacheKey = `public-schedule:${institution.id}`;
  const ttlMs = options.cacheTtlMs;
  if (options.mode === "mock") {
    return { schedule: sourceLabelSchedule(sources, options.date ?? new Date()), degraded: hasRejectedSource };
  }
  const loader = (signal: AbortSignal) => loadScheduleSources(sources, signal, hasRejectedSource, options.rruleHorizonDays);

  return getCached(
    cacheKey,
    loader,
    ttlMs,
    { shouldCache: (result) => !result.degraded }
  );
}
