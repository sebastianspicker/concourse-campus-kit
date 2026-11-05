import { createHash } from "node:crypto";
import type { InstitutionPack } from "@concourse/institutions";
import { isPublicHttpUrl, type PublicEvent } from "@concourse/contracts";
import { log } from "../../runtime/logger";
import { parseDateTimeInTimeZone } from "../time";
import { getCached, ttlUnlessDegraded } from "../upstream/cache";
import { getPublicSourceBreaker } from "../upstream/circuitBreaker";
import { fetchTextWithTimeout } from "../upstream/httpClient";

type EventIdInput = {
  sourceUrl: string;
  title: string;
  date: string;
};

/**
 * Builds a stable event ID from source URL, title, and date.
 * Use the date extracted from the page when available; if the caller passes
 * a server-time fallback (e.g. when the page has no date), the ID may change
 * across requests until the source provides a stable date.
 */
function buildEventId(input: EventIdInput): string {
  const normalized = JSON.stringify({
    sourceUrl: input.sourceUrl.trim(),
    title: input.title.trim(),
    date: input.date.trim()
  });

  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 24);
  return `evt_${hash}`;
}

const MAX_EVENTS_PER_SOURCE = 8;
const MAX_HTML_BLOCKS_TO_INSPECT = 256;
const MAX_HTML_OPENING_TAG_LENGTH = 16 * 1024;
const MAX_HTML_BLOCK_LENGTH = 256 * 1024;
export type FetchPublicEventsResult = { events: PublicEvent[]; degraded: boolean };
export type PublicEventsOptions = { cacheTtlMs: number; mode: string; date?: Date };
type PublicEventSource = { url: string; label: string };
type HtmlBlock = { content: string; full: string; openingTag: string };

function sourceLabelEvents(
  sources: PublicEventSource[],
  now: Date
): PublicEvent[] {
  return sources.map((source) => {
    const date = now.toISOString();
    return {
      id: buildEventId({ sourceUrl: source.url, title: source.label, date }),
      title: source.label,
      date,
      sourceUrl: source.url
    };
  });
}

/** Collects event sources independently so one failed upstream yields a degraded partial result. */
export async function fetchPublicEvents(
  institution: InstitutionPack,
  options: PublicEventsOptions
): Promise<FetchPublicEventsResult> {
  const configuredSources = institution.publicSources?.events ?? [];
  const sources = configuredSources.filter((source): source is PublicEventSource => isPublicHttpUrl(source.url));
  const hasRejectedSource = sources.length !== configuredSources.length;
  const now = options.date ?? new Date();
  const cacheKey = `public-events:${institution.id}`;
  const ttlMs = options.cacheTtlMs;
  const mode = options.mode;

  return getCached(
    cacheKey,
    async (signal): Promise<FetchPublicEventsResult> => {
      if (mode === "mock") {
        // Mock mode is deterministic without embedding an alternate data corpus.
        const mockEvents = sourceLabelEvents(sources, now);
        return { events: mockEvents, degraded: hasRejectedSource };
      }

      let anyFailed = hasRejectedSource;
      const timeZone = institution.timezone;
      const settledSources = await Promise.allSettled(
        sources.map(async (source) => {
          const html = await getPublicSourceBreaker("public-events", source.url).call(() => fetchTextWithTimeout(source.url, { signal }));
          return extractEventsFromHtml(html, source.url, timeZone);
        })
      );

      const parsedEvents: PublicEvent[] = [];
      settledSources.forEach((result: PromiseSettledResult<PublicEvent[]>, index: number) => {
        if (result.status === "fulfilled") {
          parsedEvents.push(...result.value);
        } else {
          anyFailed = true;
          log("warn", "public_events_source_failed", {
            source: sources[index].label,
            reason: "upstream_request_failed"
          });
        }
      });

      const deduped = dedupeAndSortEvents(parsedEvents);
      if (deduped.length > 0) {
        return { events: deduped, degraded: anyFailed };
      }

      const fallbackEvents = sourceLabelEvents(sources, now);

      // Returning source labels is a degraded fallback: it keeps the app usable
      // during upstream HTML changes without pretending the data is fresh.
      const degradedResult: FetchPublicEventsResult = { events: fallbackEvents, degraded: true };
      return degradedResult;
    },
    ttlMs,
    { ttlFor: ttlUnlessDegraded(ttlMs) }
  );
}

/**
 * Event pages use different card shapes. Prefer explicit article markup, then
 * event tiles, then dated links. Entries without a parseable date are skipped
 * because they cannot be placed on a day.
 */
function extractEventsFromHtml(
  html: string,
  sourceUrl: string,
  timeZone: string,
): PublicEvent[] {
  const articleEvents = extractEventsFromBlocks(
    collectHtmlBlocks(html, "article").map((block) => block.full),
    sourceUrl,
    timeZone
  );
  if (articleEvents.length > 0) return articleEvents;

  const tileEvents = extractEventsFromBlocks(
    collectHtmlBlocks(html, "div", (openingTag) =>
      getDoubleQuotedAttribute(openingTag, "class")?.toLowerCase().includes("event") ?? false
    ).map((block) => block.full),
    sourceUrl,
    timeZone
  );
  if (tileEvents.length > 0) return tileEvents;

  return extractLinkEvents(html, sourceUrl, timeZone);
}

function extractEventsFromBlocks(
  blocks: string[],
  sourceUrl: string,
  timeZone: string
): PublicEvent[] {
  const events: PublicEvent[] = [];
  for (const block of blocks) {
    const event = extractEventFromBlock(block, sourceUrl, timeZone);
    if (!event) continue;

    events.push(event);
    if (events.length >= MAX_EVENTS_PER_SOURCE) break;
  }
  return events;
}

function extractEventFromBlock(
  block: string,
  sourceUrl: string,
  timeZone: string
): PublicEvent | null {
  const title = extractTitle(block);
  const url = extractHref(block, sourceUrl);
  if (!title || title.length > 200 || !url) {
    return null;
  }

  const date = extractDate(block, timeZone);
  if (!date) {
    return null;
  }

  return {
    id: buildEventId({ sourceUrl: url, title, date }),
    title,
    date,
    sourceUrl: url
  };
}

function extractLinkEvents(
  html: string,
  sourceUrl: string,
  timeZone: string
): PublicEvent[] {
  const events: PublicEvent[] = [];
  const anchors = collectHtmlBlocks(html, "a", (openingTag) =>
    getDoubleQuotedAttribute(openingTag, "href") !== null
  );

  for (const anchor of anchors) {
    const event = extractEventFromLink(anchor, sourceUrl, timeZone);
    if (!event) continue;

    events.push(event);
    if (events.length >= MAX_EVENTS_PER_SOURCE) break;
  }

  return events;
}

function extractEventFromLink(
  anchor: HtmlBlock,
  sourceUrl: string,
  timeZone: string
): PublicEvent | null {
  const href = getDoubleQuotedAttribute(anchor.openingTag, "href");
  const title = normalizeVisibleText(anchor.content);
  if (!href || title.length < 4 || title.length > 120) {
    return null;
  }

  const date = extractDate(anchor.full, timeZone);
  const resolvedUrl = safeResolveUrl(href, sourceUrl);
  if (!date || !resolvedUrl) {
    return null;
  }

  return {
    id: buildEventId({ sourceUrl: resolvedUrl, title, date }),
    title,
    date,
    sourceUrl: resolvedUrl
  };
}

function dedupeAndSortEvents(events: PublicEvent[]): PublicEvent[] {
  const byId = new Map<string, PublicEvent>();
  for (const e of events) {
    byId.set(e.id, e);
  }

  return [...byId.values()].sort((a, b) => {
    if (a.date < b.date) return -1;
    if (a.date > b.date) return 1;
    return a.id.localeCompare(b.id);
  });
}

function extractTitle(block: string): string | null {
  const openingTag = openingTagFromBlock(block);
  const dataTitle = getDoubleQuotedAttribute(openingTag, "data-event-title");
  if (dataTitle) {
    const cleaned = dataTitle.trim();
    return cleaned.length > 0 ? cleaned : null;
  }

  for (const tagName of ["h2", "h3", "a"]) {
    const nested = collectHtmlBlocks(block, tagName, undefined, 1)[0];
    if (!nested) continue;
    const cleaned = normalizeVisibleText(nested.content);
    if (cleaned.length > 0) return cleaned;
  }

  return null;
}

const HTML_DATETIME_PATTERN = /datetime="([^"]+)"/i;
const GERMAN_DATE_TIME_PATTERN = /(\d{2})\.(\d{2})\.(\d{4})\s*(\d{2}):(\d{2})/;
const GERMAN_DATE_PATTERN = /(\d{2})\.(\d{2})\.(\d{4})/;

const ZONELESS_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?)?$/;

/** Reads a datetime without an offset in the institution zone; values with an offset keep native parsing. */
function parseHtmlDateTime(value: string, timeZone: string): string | null {
  const match = ZONELESS_DATETIME_PATTERN.exec(value.trim());
  if (match) {
    try {
      return parseDateTimeInTimeZone(
        {
          year: Number(match[1]),
          month: Number(match[2]),
          day: Number(match[3]),
          hour: Number(match[4] ?? 0),
          minute: Number(match[5] ?? 0),
          second: Number(match[6] ?? 0)
        },
        timeZone
      );
    } catch {
      return null;
    }
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

/** Parses source dates in the configured institution zone, never the server's local zone. */
function parseGermanDate(block: string, timeZone: string): string | null {
  const dateTimeMatch = block.match(GERMAN_DATE_TIME_PATTERN);
  if (dateTimeMatch) {
    return parseMatchedGermanDate(dateTimeMatch, timeZone);
  }

  const dateMatch = block.match(GERMAN_DATE_PATTERN);
  return dateMatch ? parseMatchedGermanDate(dateMatch, timeZone) : null;
}

/** Treats an impossible calendar date (such as 31.02.) as no date, so only that entry is skipped. */
function parseMatchedGermanDate(match: RegExpMatchArray, timeZone: string): string | null {
  try {
    return parseDateTimeInTimeZone(
      {
        year: Number(match[3]),
        month: Number(match[2]),
        day: Number(match[1]),
        hour: Number(match[4] ?? 0),
        minute: Number(match[5] ?? 0),
        second: 0
      },
      timeZone
    );
  } catch {
    return null;
  }
}

/** Uses datetime attributes before locale-dependent page text. */
function extractDate(block: string, timeZone: string): string | null {
  const datetimeMatch = block.match(HTML_DATETIME_PATTERN);
  if (datetimeMatch) {
    const parsed = parseHtmlDateTime(datetimeMatch[1], timeZone);
    if (parsed) {
      return parsed;
    }
  }

  return parseGermanDate(block, timeZone);
}

function extractHref(block: string, sourceUrl: string): string | null {
  const openingTag = openingTagFromBlock(block);
  const dataUrl = getDoubleQuotedAttribute(openingTag, "data-event-url");
  if (dataUrl) return safeResolveUrl(dataUrl, sourceUrl);
  const anchor = collectHtmlBlocks(block, "a", undefined, 1)[0];
  const href = getDoubleQuotedAttribute(anchor?.openingTag ?? openingTag, "href");
  return href ? safeResolveUrl(href, sourceUrl) : null;
}

/** Collects closed elements with one forward-only pass and explicit work budgets. */
function collectHtmlBlocks(
  html: string,
  tagName: string,
  acceptsOpeningTag: ((openingTag: string) => boolean) | undefined = undefined,
  limit = MAX_HTML_BLOCKS_TO_INSPECT
): HtmlBlock[] {
  const blocks: HtmlBlock[] = [];
  let cursor = 0;
  while (blocks.length < limit) {
    const opening = findNextOpeningTag(html, tagName, cursor);
    if (!opening) break;
    cursor = opening.end + 1;
    const openingTag = html.slice(opening.start, cursor);
    if (acceptsOpeningTag && !acceptsOpeningTag(openingTag)) continue;
    const closing = findNextClosingTag(html, tagName, cursor);
    if (!closing) break;
    const blockEnd = closing.end + 1;
    if (blockEnd - opening.start <= MAX_HTML_BLOCK_LENGTH) {
      blocks.push({ content: html.slice(cursor, closing.start), full: html.slice(opening.start, blockEnd), openingTag });
    }
    cursor = blockEnd;
  }
  return blocks;
}

/** Finds one real opening tag without retrying a closing-tag search from every candidate. */
function findNextOpeningTag(html: string, tagName: string, from: number): { start: number; end: number } | null {
  const normalizedTagName = tagName.toLowerCase();
  let start = html.indexOf("<", from);
  while (start >= 0) {
    const nameStart = start + 1;
    const nameEnd = nameStart + tagName.length;
    const boundary = html[nameEnd];
    const matchesName = html.slice(nameStart, nameEnd).toLowerCase() === normalizedTagName;
    if (matchesName && (boundary === ">" || boundary === "/" || /\s/.test(boundary ?? ""))) {
      const end = findTagEnd(html, nameEnd);
      if (end === null) return null;
      return { start, end };
    }
    start = html.indexOf("<", start + 1);
  }
  return null;
}

function findNextClosingTag(html: string, tagName: string, from: number): { start: number; end: number } | null {
  const normalizedTagName = tagName.toLowerCase();
  let start = html.indexOf("<", from);
  while (start >= 0) {
    const nameStart = start + 2;
    const nameEnd = nameStart + tagName.length;
    const matchesName = html[start + 1] === "/"
      && html.slice(nameStart, nameEnd).toLowerCase() === normalizedTagName;
    if (matchesName) {
      const end = findTagEnd(html, nameEnd);
      if (end === null) return null;
      if (html.slice(nameEnd, end).trim() === "") return { start, end };
    }
    start = html.indexOf("<", start + 1);
  }
  return null;
}

/** Finds a tag boundary without treating greater-than characters inside attributes as markup. */
function findTagEnd(value: string, from: number): number | null {
  const limit = Math.min(value.length, from + MAX_HTML_OPENING_TAG_LENGTH);
  let quote: '"' | "'" | null = null;
  for (let cursor = from; cursor < limit; cursor += 1) {
    const character = value[cursor];
    if (quote && character === quote) quote = null;
    else if (!quote && (character === '"' || character === "'")) quote = character;
    else if (!quote && character === ">") return cursor;
  }
  return null;
}

/** Reads a double-quoted attribute from one bounded opening tag. */
function getDoubleQuotedAttribute(openingTag: string, attributeName: string): string | null {
  const needle = `${attributeName.toLowerCase()}="`;
  for (let start = 0; start <= openingTag.length - needle.length; start += 1) {
    const preceding = openingTag[start - 1];
    const matchesName = openingTag.slice(start, start + needle.length).toLowerCase() === needle;
    if (matchesName && (start === 0 || preceding === "<" || /\s/.test(preceding))) {
      const valueStart = start + needle.length;
      const valueEnd = openingTag.indexOf('"', valueStart);
      return valueEnd < 0 ? null : decodeEntities(openingTag.slice(valueStart, valueEnd));
    }
  }
  return null;
}

function openingTagFromBlock(block: string): string {
  const end = findTagEnd(block, 1);
  return end === null ? "" : block.slice(0, end + 1);
}

/** Removes markup in linear time before normalizing visible whitespace. */
function normalizeVisibleText(value: string): string {
  let text = "";
  let cursor = 0;
  while (cursor < value.length) {
    const open = value.indexOf("<", cursor);
    if (open < 0) { text += value.slice(cursor); break; }
    text += `${value.slice(cursor, open)} `;
    const close = findTagEnd(value, open + 1);
    if (close === null) { text += value.slice(open); break; }
    cursor = close + 1;
  }
  return decodeEntities(text).replace(/\s+/g, " ").trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", ndash: "\u2013", mdash: "\u2014",
  hellip: "\u2026", auml: "\u00e4", ouml: "\u00f6", uuml: "\u00fc", Auml: "\u00c4", Ouml: "\u00d6",
  Uuml: "\u00dc", szlig: "\u00df", euro: "\u20ac"
};

/** Decodes common named and numeric references in one pass; unknown or invalid ones stay as written. */
function decodeEntities(value: string): string {
  return value.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z]{2,8}));/g, (whole, dec, hex, name) => {
    if (name) return NAMED_ENTITIES[name] ?? whole;
    const code = dec ? Number(dec) : parseInt(hex, 16);
    const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
    return valid ? String.fromCodePoint(code) : whole;
  });
}

function safeResolveUrl(href: string, sourceUrl: string): string | null {
  try {
    const url = new URL(href, sourceUrl);
    if (!isPublicHttpUrl(url.toString())) return null;

    // Safety check: prevent extreme URL lengths
    if (url.toString().length > 2048) return null;

    return url.toString();
  } catch {
    return null;
  }
}
