# Public sources

The API loads one institution pack and reads only the sources that pack
configures. Everything it accepts is public and credential-free.

| Route | Input |
|---|---|
| `/events` | Public HTTP(S) pages in `publicSources.events` |
| `/schedule` | Public ICS feeds in `publicSources.schedules` |
| `/rooms` | `publicRooms` in the pack |
| `/today` | Same-day public events and pack-defined rooms |

The source adapters live in `apps/api/src/sources/web-events/` and
`apps/api/src/sources/ics/`. They normalize upstream data into the public
resource schemas in `packages/contracts/src/resources/`.

## How event pages are read

The events adapter applies the same rules to every institution's pages. It
looks for `<article>` elements first, then elements whose `class` contains
`event`, then plain links. Each entry needs a title (`data-event-title`, the
first `h2`, `h3`, or link text), a public link (`data-event-url` or the first
`href`), and a date: a `datetime="…"` attribute, such as on `<time>`, or a
`dd.mm.yyyy` date with an optional `hh:mm` time. A `datetime` without an offset
and every `dd.mm.yyyy` date are read in the pack's time zone. HTML entities in
titles and links (`&amp;`, `&szlig;`, numeric references) are decoded.
Entries without a date are skipped. Each page contributes at most 8 events, and
`/events` returns the events of all pages together.

## When a source fails

- Fetches have bounded timeouts, and failures are logged with request context.
- If at least one event or schedule source succeeds, the API can return partial
  data with `_degraded: true`.
- Degraded source results stay in the API's in-process source cache for at most
  60 seconds, so one broken source cannot multiply requests to the university
  site. A successful HTTP response still carries private cache headers, so the
  client may persist a validated degraded response for bounded offline use.
- If configured event pages yield no parsed events, the events adapter returns
  source-label fallback records with `_degraded: true`. If every configured
  schedule source fails, the API returns a sanitized error.
- ICS recurrence expansion is bounded by `RRULE_EXPANSION_HORIZON_DAYS`.
- ICS times without a zone (floating times), all-day dates, and `TZID` names
  that are not IANA zones (such as Outlook's `W. Europe Standard Time`) are read
  in the pack's time zone. All-day entries start at local midnight.
- Moved occurrences (`RECURRENCE-ID`) replace their original slot, and
  `STATUS:CANCELLED` events and occurrences are left out.
- `/schedule` returns at most 1000 occurrences across all feeds. When the feeds
  together hold more, upcoming occurrences are kept first, so a query for a
  past range can miss occurrences; `_total` counts the retained occurrences
  that match the query.

Tests and offline local runs set `PUBLIC_EVENTS_MODE=mock` to derive
deterministic event and schedule records from the configured source labels
without fetching them, and `PUBLIC_EVENTS_DATE` to fix the event, schedule, and
Today clock. Do not set either value in production: live
behavior uses the default `auto` mode and the real clock.

## Add a public source

1. Add an unauthenticated public HTTP(S) URL to an institution pack.
2. Reuse an existing parser where you can; otherwise extend the relevant API
   source adapter.
3. Add deterministic parser and response tests, including malformed input and
   partial-source failure.
4. Verify the pack and the affected API package, then run `pnpm verify`.

Never add authenticated URLs, internal hostnames, tokens, captured user data, or
protected-system content. This repository contains no private connector code.
