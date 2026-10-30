# Changelog

## Repository naming migration

The repository moves from `sebastianspicker/concourse` to
`sebastianspicker/concourse-campus-kit`. Product commands, data formats, and runtime
identifiers remain unchanged. The demo moves to
https://sebastianspicker.github.io/concourse-campus-kit/.

All notable changes to this project will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`1.2.0-alpha.1` is the current source candidate. It is not published until the
matching tag workflow creates the GitHub prerelease and the versioned BFF image.

## [Unreleased]

### Changed

- Client redesign, "Departure Hall": bundled Atkinson Hyperlegible Next and
  Mono, a mineral hall palette with one ink Now/Next board, status lamps whose
  shape carries the state, board-style rows, a bottom navigation bar on
  phones, and rewritten English and German copy.
- Client redesign, "Stage", on top of Departure Hall: Outfit (heavy,
  uppercase) for the current entry, clock, titles, and actions; Concourse Text
  (renamed Source Sans 3 subset) for everything else; black on white with flat
  orange "now" and institution-color blocks; event cards with round arrows;
  square corners. Atkinson Hyperlegible is no longer bundled.
- Institution accents are validated as flat fills (readable black or white
  text, visible against the canvas); the client derives a readable tint for
  text use. The example pack uses `#2A62F0`.
- Today's Now shows the schedule entry in progress instead of "Campus is
  open", and Next shows the nearest entry that has not started, regardless of
  sort order. While the schedule loads or fails, the board says so.
- The campus clock and Now/Next update every minute.

### Fixed

- The static demo's Events tab lists events from the current campus day
  instead of a fixed date weeks in the past.
- Time spans use a spaced hyphen (`10:00 - 11:30`) instead of an en dash.
- Dark mode on the web no longer mixes light server styles into a dark page
  after hydration.
- The static demo's Today schedule follows the current campus day instead of a
  fixed past date.
- The client, contracts, institutions, and tooling test suites are tracked and
  run in CI and `pnpm verify`; an empty suite now fails instead of passing.
- Builds and type checks use the workspace TypeScript compiler (`tsc6`)
  instead of whatever global `tsc` the machine has, so the BFF container
  image builds again.
- Event pages of every institution are parsed for dates (`datetime`
  attributes and `dd.mm.yyyy` dates), not only HfMT pages; entries without a
  date are skipped instead of appearing as 1 January 1970, so Today and Events
  work for institutions other than HfMT.
- `/events` returns the events of all configured pages instead of at most 8
  in total.
- `/schedule` no longer fails with a server error when several ICS feeds
  together hold more than 1000 occurrences; it keeps the 1000 most relevant
  (upcoming first) in chronological order.
- The API's per-client request limit is configurable with
  `BFF_RATE_LIMIT_MAX` and `BFF_RATE_LIMIT_WINDOW_SECONDS` (defaults unchanged:
  60 requests per 60 seconds), so testers behind one proxy need not share a
  60-per-minute budget.
- When the API is rate limited or slow, the app shows saved data or the
  rate-limit message instead of "took too long": retries finish within a
  12-second budget and a long `Retry-After` is not waited out.
- `PUBLIC_EVENTS_MODE=mock` also covers `/schedule`, and the README's local run
  uses it, so the documented `example` setup works offline instead of
  returning placeholder events and a schedule error.
- Release builds now publish the API image as `ghcr.io/<owner>/<repo>/bff`,
  derived from the repository, as `docs/release.md` documents; the workflow
  previously pushed the pre-rename `ghcr.io/sebastianspicker/concourse/bff`.

---

## [1.2.0-alpha.1] - 2026-07-17

### Added

- Concourse product and design contracts, English and German localization,
  institution identity, and light, dark, system, and high-contrast appearance
  settings.
- The Concourse Campus Kit technical identity, route-C application assets, and a
  one-time migration from the legacy local storage keys.
- Three institution-selectable design presets: the default `wayfinding` preset,
  plus `atelier` and `precision`.
- Responsive rail and tab navigation, virtualized public resource lists, public
  detail workflows, and localized freshness and error states.
- BFF institution identity headers and client-side configuration mismatch
  detection.
- Strict release metadata preflight for SemVer tags, workspace packages, the
  Expo marketing version, and changelog notes.

### Changed

- Upgraded the mobile app to Expo SDK 57, React Native 0.86, React 19.2, and
  Node.js 22.13 or newer.
- Replaced the demo Profile and authentication experience with Settings, keeping
  a compatibility redirect.
- Consolidated frontend styling on typed React Native tokens, shared workflow
  primitives, and pack-controlled design presets.
- Made `pnpm verify` enforce release identity, architecture boundaries, focused
  tests, and fresh builds.
- Moved the release BFF image to Node 22.13 and added a non-default-port health
  smoke test before registry publication.
- Hardened public ICS parsing with bounded recurrence work, explicit timezone
  handling, and broader malformed-input coverage.
- Pinned the owner-managed EAS CLI path and added an explicit Docker
  build-context boundary for local artifacts and secrets.

### Fixed

- Made the BFF health version explicit in release images, and its container
  health probes honor both `BFF_PORT` and enabled bearer authentication.
- Included the repository MIT notice in BFF container images.

### Security

- Added exact IP/CIDR trusted-proxy configuration and allowlisted multi-hop
  forwarded-client resolution; ambiguous `auto` trust is rejected.
- Kept prerelease images off the floating `latest` tag and restored default
  secret detection across every tracked or force-added public path.
- Added checksum verification before the Gitleaks release archive is extracted
  in CI.
- Made the main CI policy gate run for every pull request.
