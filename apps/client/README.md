# Client

`@concourse/client` is the Expo Router application for native and responsive
web. API-backed operation talks only to the Concourse API, validates every
public response, and keeps a labeled persisted cache for offline and degraded
use.

## Run

From the repository root:

~~~bash
test -e apps/client/.env || cp apps/client/.env.example apps/client/.env
INSTITUTION_ID=example pnpm --filter @concourse/client start
~~~

Set `EXPO_PUBLIC_BFF_BASE_URL` in `apps/client/.env` to a URL the target client
can reach, and run the API with the same `INSTITUTION_ID` in another terminal.
Use `dev` only when a compatible development client is installed:

~~~bash
INSTITUTION_ID=example pnpm --filter @concourse/client dev
~~~

## Layout

- `app/` holds the Expo Router routes and a local health route.
- `src/shell/` holds shared app chrome and boundary components.
- `src/data/public/` owns API-backed resources, static-demo data, and cache use.
- `src/design-system/` owns the theme and reusable UI primitives.
- `src/features/` composes route-oriented screens.
- `src/platform/` owns environment, HTTP, storage, network, and sharing edges.

`CONCOURSE_STATIC_DEMO=1` enables fixture-only static export. It must not call
the API or external sources. API-backed responses are validated against the
[shared contracts](../../packages/contracts/README.md) before they reach the
cache or UI. Preview and production requirements are in
[client deployment](../../docs/deploy/mobile.md).

~~~bash
pnpm --filter @concourse/client test
pnpm --filter @concourse/client typecheck
~~~

## Saved data

Concurrent loads for the same query share one request, including a
refresh. Cancelling one view leaves other consumers running. Valid network data
appears without waiting for storage, and saving is best effort. The versioned
public cache keeps up to 50 query entries for 24 hours, with a 4 MiB UTF-8
total and a 1 MiB per-entry limit. Expired entries are evicted first, then the
oldest writes.

Clearing saved data removes the persisted public cache and the detail cache but keeps
already-visible information, language, and appearance. It cancels pending loads
without fetching a replacement. Later navigation, refresh, reconnect, or an
eligible foreground or focus transition can save data again. See the
[runbook](../../docs/runbook.md) for the recovery rules.

`pnpm verify:web` runs Chromium coverage for the exported demo and the
API-backed client with intercepted responses. Install the pinned browser first
with `pnpm exec playwright install chromium`. Native device checks stay separate.
