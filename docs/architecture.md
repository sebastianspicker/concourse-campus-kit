# Architecture

Concourse keeps public-source ingestion separate from presentation. The API
selects one validated institution pack, normalizes public web and ICS inputs,
and serves contract-validated JSON. The Expo client validates the same wire
contract, keeps public data for bounded offline use, and renders explicit
freshness and failure states.

## What runs where

This diagram answers "which processes exist and what talks to what".

~~~mermaid
flowchart LR
  user((Person))
  pack[[Institution pack]]
  upstream[Public event pages<br/>and ICS feeds]
  subgraph device [Device or browser: apps/client]
    screens[Feature screens]
    publicApi["publicApi.ts"]
    store[(AsyncStorage cache)]
  end
  subgraph bff [Node.js process: apps/api]
    listener["http/listener.ts"]
    usecases[application use cases]
    sources["sources/ adapters"]
  end
  user -->|opens a tab| screens
  screens -->|"useEvents, useToday, ..."| publicApi
  publicApi -->|"GET /events, /today, ..."| listener
  publicApi -.->|save validated data| store
  listener -->|parsed query| usecases
  usecases -->|"fetchEvents, fetchSchedule"| sources
  sources -->|guarded HTTPS GET| upstream
  pack -->|rooms, source URLs| usecases
  pack -->|"identity, timezone, theme"| screens
  classDef focus fill:#fde68a,stroke:#b45309,color:#1f2937
  class listener focus
~~~

There are exactly two runtime processes: the BFF (one Node.js HTTP server,
port 4000 in the local container) and the client (an Expo app on a phone, or
its web export in a browser). The BFF is the only part that ever contacts
campus sources. The client reaches campus data only through `listener`, and
only falls back to `store` when the network fails. The institution pack is not
a service: both sides compile the same pack from `packages/institutions` and
must be built with the same `INSTITUTION_ID`. There is no server-side database;
the API keeps only an in-memory source cache.

The static demo (`CONCOURSE_STATIC_DEMO=1`) cuts the diagram at `publicApi`: it
answers from repository fixtures and never calls `listener` or `store`.

Where in the code:

- [apps/api/src/server.ts](../apps/api/src/server.ts): starts the HTTP server and owns shutdown.
- [apps/api/src/http/listener.ts](../apps/api/src/http/listener.ts): per-request pipeline.
- [apps/client/src/data/public/publicApi.ts](../apps/client/src/data/public/publicApi.ts): every client data request.
- [apps/client/src/data/public/persistedCache.ts](../apps/client/src/data/public/persistedCache.ts): the `store` above.
- [packages/institutions/src/registry.ts](../packages/institutions/src/registry.ts): pack lookup by ID.

## What happens when someone opens Events

This sequence follows one request from a tap to a public web page and back.
`/today`, `/schedule`, and `/rooms` take the same path; schedule data comes from
the ICS adapter, and rooms come straight from the pack without an upstream call.

~~~mermaid
sequenceDiagram
  autonumber
  actor U as Person
  participant screen as EventsScreen
  participant api as publicApi.ts
  participant bff as BFF listener
  participant uc as getEvents
  participant src as fetchPublicEvents
  participant web as Public event pages
  U->>screen: Open Events tab
  screen->>api: useEvents(filter)
  api->>bff: GET /events?search=...
  bff->>bff: CORS, auth, rate limit, GET only
  bff->>uc: getEvents(pack, query)
  uc->>src: fetchEvents(pack)
  opt source cache miss
    src->>web: GET each configured page
    web-->>src: HTML
  end
  src-->>uc: events, degraded flag
  uc-->>bff: search, date range, paging
  bff-->>api: 200 JSON + ETag
  api-)api: save to AsyncStorage
  api-->>screen: data, source "network"
~~~

- **3**: `getJsonResult` retries eligible failures inside a 12-second budget
  and checks the returned `x-institution-id`.
- **4**: the listener assigns `x-request-id` and applies security headers before
  any guard can reject the request.
- **7–8**: each configured source is fetched independently behind a circuit
  breaker and the SSRF-guarded HTTP client. A failed source makes the result
  degraded instead of failing the request. The source cache (`getCached`)
  shares concurrent loads and keeps degraded results for at most 60 seconds.
- **10–11**: the API validates the body with `EventsResponseSchema` before
  sending it, and sets `x-data-degraded` when needed; the client validates it
  again with the same schema before using or saving it.

Where in the code:

- [apps/client/src/features/events/EventsScreen.tsx](../apps/client/src/features/events/EventsScreen.tsx) and
  [apps/client/src/data/public/resources.ts](../apps/client/src/data/public/resources.ts) (steps 1–2)
- [apps/client/src/platform/http/client.ts](../apps/client/src/platform/http/client.ts) (step 3)
- [apps/api/src/http/listener.ts](../apps/api/src/http/listener.ts) (step 4) and
  [apps/api/src/http/routes.ts](../apps/api/src/http/routes.ts) (steps 5 and 11)
- [apps/api/src/application/events.ts](../apps/api/src/application/events.ts) (steps 5 and 10)
- [apps/api/src/sources/web-events/publicEvents.ts](../apps/api/src/sources/web-events/publicEvents.ts),
  [apps/api/src/sources/upstream/cache.ts](../apps/api/src/sources/upstream/cache.ts) and
  [apps/api/src/sources/upstream/httpClient.ts](../apps/api/src/sources/upstream/httpClient.ts) (steps 6–9)

## What happens when the network fails

This sequence shows when the client shows saved data instead of an error.

~~~mermaid
sequenceDiagram
  autonumber
  participant screen as Feature screen
  participant api as publicApi.ts
  participant pc as persistedCache.ts
  participant http as http/client.ts
  participant store as AsyncStorage
  screen->>api: fetchEvents(filter)
  api->>pc: fetchNetworkFirstWithFallback(key)
  par network first
    pc->>http: getJsonResult(path)
  and saved copy in parallel
    pc->>store: read entry for key
  end
  http--xpc: timeout or retryable error
  alt saved entry valid and at most 24 h old
    pc->>store: mark entry offline
    pc-->>api: saved data, cacheAge
    api-->>screen: source "persisted-cache"
  else no usable entry, or non-transient error
    pc--xapi: rethrow error
    api--xscreen: error or unavailable state
  end
~~~

Only transient failures (timeouts, network errors, retryable HTTP statuses)
fall back to saved data (steps 6–8). Validation failures and institution
mismatches always surface as errors, so the app never shows data it could not
trust. Saved data reaches the screen with its age, and the UI labels it cached
or offline rather than current. Same-key requests from several screens share one
network load through `shareLoad`.

Where in the code:

- [apps/client/src/data/public/persistedCache.ts](../apps/client/src/data/public/persistedCache.ts): `fetchNetworkFirstWithFallback` (steps 2–9)
- [apps/client/src/platform/http/errors.ts](../apps/client/src/platform/http/errors.ts): `isTransientPublicDataFailure`
- [apps/client/src/data/public/cache.ts](../apps/client/src/data/public/cache.ts): `shareLoad`
- [apps/client/src/data/public/usePublicResource.ts](../apps/client/src/data/public/usePublicResource.ts): turns results into screen state

## Code map

Read in this order: the wire contract first, then the API from the outside in,
then the client from the data layer up.

| Path | Responsibility |
|---|---|
| [packages/contracts/src](../packages/contracts/src) | Zod resource schemas plus shared routes, queries, headers, public-URL policy, and error envelope |
| [packages/institutions/src](../packages/institutions/src) | Institution-pack schema, branding validation, bundled public packs, and registry |
| [apps/api/src/server.ts](../apps/api/src/server.ts) | Entry point: loads configuration once, builds the listener (which binds source adapters to that configuration in `http/routes.ts`), and owns shutdown |
| [apps/api/src/http](../apps/api/src/http) | Listener, query parsing, route dispatch, response validation, cache headers, and error mapping; `http/respond.ts` is the dependency-free response layer |
| [apps/api/src/security](../apps/api/src/security) | Optional bearer auth, CORS, proxy trust, client identity, rate limiting, and response headers |
| [apps/api/src/application](../apps/api/src/application) | Transport-neutral events, rooms, schedule, and Today use cases |
| [apps/api/src/sources](../apps/api/src/sources) | Public HTML and ICS acquisition, parsing, recurrence expansion, partial-failure handling, and (in `upstream/`) the guarded outbound HTTP client, source cache, and circuit breakers |
| [apps/api/src/runtime](../apps/api/src/runtime) | Process concerns: environment parsing (the only `process.env` reader), selected-pack loading, and structured logging |
| [apps/client/app](../apps/client/app) | Expo Router route declarations; each file re-exports a feature screen |
| [apps/client/src/platform](../apps/client/src/platform) | Environment, HTTP, storage, network, and sharing adapters |
| [apps/client/src/data](../apps/client/src/data) | Contract validation, request coordination, persisted cache, and static-demo fixtures |
| [apps/client/src/features](../apps/client/src/features), [design-system](../apps/client/src/design-system), [shell](../apps/client/src/shell), [localization](../apps/client/src/localization) | User flows, shared UI, application chrome, and locale-aware presentation |
| [scripts](../scripts) | Verify gate, architecture checker, Pages, container, and screenshot tools |

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

The two sequences above show the main path. Rules they leave out:

- The client transport resolves the configured BFF origin and refuses paths
  that would leave it. A `Retry-After` wait that does not fit the 12-second
  budget ends the request with the rate-limit or server error, so saved data or
  the matching message is shown instead of a timeout.
- The listener loads the configured `INSTITUTION_ID` per request. An unknown ID
  fails closed.
- Query parsing and filtering stay in `http/` and `application/`, never in the
  source adapters.
- The resource hook accepts only the currently owned request, aborts superseded
  work, and keeps already-rendered data during a refresh.

The routes are `GET /health`, `/events`, `/rooms`, `/schedule`, and `/today`.
`/today` accepts an optional `date=YYYY-MM-DD`. The remaining filters are defined
in `packages/contracts/src/http/queries.ts` and parsed by the API.

## State and caching

- The API keeps a bounded in-process source cache and deduplicates concurrent
  loads. `BFF_DEFAULT_CACHE_TTL` controls source-cache lifetime.
- Degraded event and schedule results are returned and kept in the API source
  cache for at most 60 seconds.
- Successful data responses, including degraded ones, use private HTTP cache
  headers and ETags. The API reports degradation in the response body and in
  `x-data-degraded`.
- Same-key client loads share transport and persistence. Cancelling one consumer
  detaches only that consumer; the final cancellation aborts the transport. A
  refresh joins an active same-key load. Every load goes to the network first;
  there is no in-memory response cache.
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
  clears the detail cache before deleting versioned current and
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
