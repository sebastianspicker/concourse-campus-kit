# Architecture

Concourse keeps public-source ingestion separate from presentation. The API
selects one validated institution pack, normalizes public web and ICS inputs,
and serves contract-validated JSON. The Expo client validates the same wire
contract, keeps public data for bounded offline use, and renders explicit
freshness and failure states.

## System context

~~~mermaid
flowchart LR
  Pack[Validated institution pack]
  HTML[Public event pages]
  ICS[Public ICS feeds]
  API[apps/api BFF]
  HTTP[Typed HTTP JSON]
  Client[apps/client]
  Cache[Memory and persisted public-data cache]
  UI[Native and web routes]

  Pack --> API
  HTML --> API
  ICS --> API
  API --> HTTP
  HTTP --> Client
  Pack -->|identity, timezone, presentation| Client
  Client --> Cache
  Cache --> UI
~~~

The API is the only runtime boundary for API-backed campus data. The client
imports the selected pack for local identity, timezone, and presentation
defaults, but it never fetches campus sources and never imports API source. The
static demo is the one exception to API-backed data: it resolves repository
fixtures before any HTTP or persisted-cache path runs.

## Components

| Area | Responsibility |
|---|---|
| `packages/contracts` | Zod resource schemas plus shared routes, queries, headers, public-URL policy, and error envelope |
| `packages/institutions` | Institution-pack schema, branding validation, bundled public packs, and registry |
| `apps/api/src/application` | Transport-neutral events, rooms, schedule, and Today use cases |
| `apps/api/src/sources` | Public HTML and ICS acquisition, parsing, recurrence expansion, partial-failure handling, and (in `upstream/`) the guarded outbound HTTP client, source cache, and circuit breakers |
| `apps/api/src/runtime` | Process concerns: environment parsing (the only `process.env` reader), selected-pack loading, and structured logging |
| `apps/api/src/security` | Optional bearer auth, CORS, proxy trust, client identity, rate limiting, and response headers |
| `apps/api/src/http` | Listener, query parsing, route dispatch, response validation, cache headers, and error mapping; `http/respond.ts` is the dependency-free response layer |
| `apps/api/src/server.ts` | Entry point: loads configuration once, builds the listener (which binds source adapters to that configuration in `http/routes.ts`), and owns shutdown |
| `apps/client/app` | Expo Router route declarations and route-level composition |
| `apps/client/src/platform` | Environment, HTTP, storage, network, and sharing adapters |
| `apps/client/src/data` | Contract validation, request coordination, memory cache, persisted cache, and static-demo fixtures |
| `apps/client/src/features`, `design-system`, `shell`, `localization` | User flows, shared UI, application chrome, and locale-aware presentation |

## Workspace dependency direction

All four workspaces are private packages. "Public contract" describes the data
boundary, not npm publication.

~~~mermaid
flowchart TD
  Contracts[packages/contracts]
  Institutions[packages/institutions]
  API[apps/api]
  Client[apps/client]

  Contracts --> Institutions
  Contracts --> API
  Institutions --> API
  Contracts --> Client
  Institutions --> Client
  API -. runtime HTTP only .-> Client
~~~

`scripts/check-architecture.mjs` verifies the declared workspace edges, rejects
dependency cycles and direct relative cross-workspace imports, and blocks API
and client source imports in either direction. It also enforces these internal
rules:

- API application code cannot depend on HTTP, runtime, security, sources, Node
  globals, or `process.env`.
- API sources cannot depend on application, HTTP, or security code; runtime
  cannot depend on anything above it except the proxy-trust parser that
  configuration validation uses.
- `http/respond.ts` imports no other API module, and security code may use
  only that file from the HTTP layer.
- Only `runtime/config.ts` reads `process.env`; `server.ts` passes it in.
- Client platform, data, design-system, and localization code cannot import
  the layers above them (shell and features; platform also not data), and one
  feature cannot import another feature directly. Shell, features, and `app/`
  routes may import any lower layer.

## Request and data flow

1. A client public-data hook builds a route and query from the constants and
   types in `@concourse/contracts`.
2. The client transport resolves the configured BFF origin, bounds the request,
   retries eligible failures within a 12-second budget, and checks a returned
   `x-institution-id` against the client build. A `Retry-After` wait that does
   not fit the budget ends the request with the rate-limit or server error, so
   saved data or the matching message is shown instead of a timeout.
3. The API listener assigns `x-request-id`, applies CORS and security headers,
   handles `OPTIONS`, then enforces optional bearer auth, rate limits, and the
   `GET`-only route contract.
4. The listener loads the configured `INSTITUTION_ID`. An unknown ID fails
   closed.
5. Application handlers read pack-defined rooms or call source adapters for
   public event pages and ICS feeds. Query parsing and filtering stay outside
   the source adapters.
6. The API validates the response with the route's Zod schema before sending
   JSON, and the client validates it again before exposing or persisting it.
7. The resource hook accepts only the currently owned request, aborts superseded
   work, and keeps already-rendered data during a refresh.

The routes are `GET /health`, `/events`, `/rooms`, `/schedule`, and `/today`.
`/today` accepts an optional `date=YYYY-MM-DD`. The remaining filters are defined
in `packages/contracts/src/http/queries.ts` and parsed by the API.

## State and caching

- The API keeps a bounded in-process source cache and deduplicates concurrent
  loads. `BFF_DEFAULT_CACHE_TTL` controls source-cache lifetime.
- Degraded event and schedule results are returned but not inserted into the API
  source cache.
- Successful data responses, including degraded ones, use private HTTP cache
  headers and ETags. The API reports degradation in the response body and in
  `x-data-degraded`.
- Same-key client loads share transport and persistence. Cancelling one consumer
  detaches only that consumer; the final cancellation aborts the transport. A
  forced refresh joins an active same-key load, and explicit memory-cache reads
  stay available.
- Network work starts independently of storage discovery. Validated results
  reach callers before best-effort persistence finishes. Successful storage
  discovery is memoized, and unavailable storage can be retried on foreground.
- The client keeps all query types in a schema-validated public cache: 50
  entries, 4 MiB serialized UTF-8 total, 1 MiB per entry, and a 24-hour
  expiration. Eviction removes expired entries before the oldest writes, with
  key order breaking ties. A metadata index avoids rediscovering every value on
  each write.
- A generation boundary and a serialized mutation queue order writes,
  migrations, offline markers, and clears. Clear cancels pending loads and
  clears the memory and detail caches before deleting versioned current and
  legacy public keys. Rendered data stays visible, late results are discarded,
  and a clear does not launch a replacement load. Preferences and unrelated
  values are preserved.
- Cache mutation notifications keep the saved-data disclosure current. Shared
  connectivity, foreground, and focus observation recover eligible resources;
  network data becomes eligible after 60 seconds, and transition bursts coalesce
  within 750 ms. Validation failures and institution mismatches are excluded.
- Persisted data is a fallback only for eligible transient failures, and only
  within the client's fixed 24-hour age limit. The UI receives cache source and
  age metadata so it can tell cached or offline data from current data.
- Missing source configuration is `404 not_found`. Events may fall back to
  source-label records when configured HTML sources produce no parsed events;
  that result is explicitly degraded. A complete schedule-source failure is an
  error.
- `/health` reports process and selected-pack readiness. It does not probe
  public upstream sources.

## Trust boundaries

Institution packs and public event links accept only credential-free public
HTTP(S) URLs. Outbound API fetches revalidate URLs and redirects, resolve DNS,
reject private or mixed address results, pin the validated address, and bound
redirect count, timeout, and response size.

The optional bearer guard is disabled unless explicitly enabled, and invalid or
incomplete auth configuration fails closed. Forwarded client identity is
ignored by default. Deployments that need it must configure an exact trusted
proxy IP/CIDR allowlist or deliberately choose the high-risk `always` mode.

The repository owns no server-side database and no user account state. Client
preferences and public-data cache entries live in the application. Never place
secrets, personal data, protected identifiers, or private endpoints in packs,
fixtures, logs, or source.

## Build and deployment boundaries

Turbo builds shared packages before their consumers, and each workspace build
clears its generated output before compiling. The production API Dockerfile is a
separate deployable boundary and runs the compiled service as a non-root user.
Both Docker builds install from manifests before copying source and use
`pnpm --filter @concourse/api deploy --prod` to assemble the complete runtime
closure. API and shared-package file allowlists include `dist`. Shared build
helpers invalidate Turbo tasks, and CI saves revision-specific Turbo archives.

The server lifecycle drains active requests for 10 seconds on SIGINT or SIGTERM,
closes idle connections immediately, and cleans up cache-owned work once after
completion or the deadline. Container stop allowances must be at least 15
seconds. The Pages workflow exports and verifies the fixture-only web demo. EAS
client builds, signing, store submission, hosted infrastructure, and target
device validation belong to the adopting institution and are outside the local
source gate.

The manually dispatched release workflow validates an existing tag, metadata and source, builds and smoke-tests
the API image, publishes versioned GHCR tags, and creates a GitHub Release in
separate jobs. Publication is therefore not atomic.

## Extension points and invariants

- Add or change wire fields in `packages/contracts`, then update API producers,
  client consumers, and contract tests together.
- Add institution-specific public data through the pack schema and registry, not
  hard-coded branches in either application.
- Extend public inputs in `apps/api/src/sources`, and keep network acquisition,
  parsing, and application filtering in their existing layers.
- Preserve the API-only data boundary, response revalidation, explicit client
  states, static-demo isolation, and public-only source policy.

Protected connectors, SSO, accounts, personalized schedules, occupancy,
credentials, signing, and institution-specific private infrastructure are
deliberate non-goals of this repository.

## Related documentation

- [Shared wire contracts](../packages/contracts/README.md)
- [Institution packs](institutions.md)
- [Public source adapters](connectors.md)
- [API service](../apps/api/README.md)
- [Client application](../apps/client/README.md)
- [Runbook](runbook.md)
