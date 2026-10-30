# Runbook

## Local operation

~~~bash
corepack pnpm@9.15.0 install --frozen-lockfile
test -e apps/api/.env || cp apps/api/.env.example apps/api/.env
test -e apps/client/.env || cp apps/client/.env.example apps/client/.env
~~~

Start the API, then the client in another terminal:

~~~bash
INSTITUTION_ID=example pnpm --filter @concourse/api dev
INSTITUTION_ID=example pnpm --filter @concourse/client start
~~~

The client's `dev` script needs an installed, compatible development client.
`EXPO_PUBLIC_BFF_BASE_URL` must point at an address the simulator, browser,
emulator, or device can reach. Plain HTTP is accepted only on loopback; use an
HTTPS tunnel or a locally trusted HTTPS proxy for physical-device development.

## Configuration

| API variable | Behavior |
|---|---|
| `INSTITUTION_ID` | Required; must resolve through the institution registry. |
| `BFF_PORT` | Integer 1–65535; default 4000. |
| `CORS_ORIGINS` | Optional comma-separated origins; none are allowed by default. |
| `BFF_DEFAULT_CACHE_TTL` | Integer 1–86400 seconds; default 300. |
| `RRULE_EXPANSION_HORIZON_DAYS` | Integer 1–366 days; default 90. |
| `BFF_RATE_LIMIT_MAX` | Integer 1–100000 requests per client per window; default 60. Failed bearer-token attempts keep a separate fixed bucket of 60 per minute. |
| `BFF_RATE_LIMIT_WINDOW_SECONDS` | Integer 1–3600 seconds; default 60. |
| `BFF_REQUIRE_AUTH` / `BFF_AUTH_TOKEN` | Optional bearer guard and its required secret. |
| `BFF_TRUSTED_PROXIES` | Optional exact IP/CIDR allowlist for forwarded identity. |
| `BFF_TRUST_PROXY` | `never` by default; accepts `never` or `always`. |

ICS recurrence processing accepts `FREQ`, positive `INTERVAL`, `COUNT`, `UNTIL`,
`WKST`, unnumbered `BYDAY` on daily-or-coarser rules, and time selectors no finer
than their recurrence frequency. Other `BY*` combinations are treated as an
unsupported recurrence and the base event remains available without expansion.

`BFF_TRUSTED_PROXIES` enables trusted-proxy mode when no explicit mode overrides
it. `always` trusts client-supplied forwarding headers and is only appropriate
behind an isolated edge that replaces them.

`PUBLIC_EVENTS_MODE` and `PUBLIC_EVENTS_DATE` are deterministic test and
local-development controls. `PUBLIC_EVENTS_MODE=mock` serves events and schedule
items derived from the pack's source labels without fetching them, and marks
responses with `x-data-mode: mock`; API tests and the README's local run use it.
Leave both unset in production so sources use `auto` mode and the real clock.

| Client variable | Behavior |
|---|---|
| `EXPO_PUBLIC_BFF_BASE_URL` | API URL; required for API-backed runtime, HTTPS-only for release builds. |
| `INSTITUTION_ID` | Required for preview and production; aligns the client with the API pack. |
| `MOBILE_BUNDLE_IDENTIFIER` | Required for production iOS builds. |
| `MOBILE_ANDROID_PACKAGE` | Required for production Android builds. |

## Endpoints and response state

| Endpoint | Query | Behavior |
|---|---|---|
| `GET /health` | none | Process, selected-pack, uptime, and memory status; no upstream probe. |
| `GET /events` | `search`, `from`, `to`, `limit`, `offset` | Normalized public events. |
| `GET /rooms` | `search`, `campus`, `limit`, `offset` | Pack-defined public rooms. |
| `GET /schedule` | `search`, `campus`, `from`, `to`, `limit`, `offset` | Normalized public ICS occurrences. |
| `GET /today` | `date=YYYY-MM-DD` | Campus-local events and rooms. |

`/health` sends `Cache-Control: no-store` and returns 200 for `ok` or `warning`,
503 for `error`. Missing route data returns `404 not_found`. Partial event or
schedule responses can include `_degraded: true` and `x-data-degraded: true`.
Those results are not stored in the API source cache, but the HTTP response
stays privately cacheable, and the client may persist validated degraded data
for bounded offline use. Every response includes `x-request-id`; data responses
identify their pack with `x-institution-id`.

## Verification

~~~bash
pnpm lint
pnpm check:architecture
pnpm typecheck
pnpm test
pnpm build
pnpm verify
pnpm exec playwright install chromium
pnpm verify:web
pnpm verify:containers
~~~

`pnpm check:architecture` enforces the workspace dependency graph and the
client-to-API source-import boundary. Workspace builds clear generated `dist`
output before compiling. `pnpm verify` is the complete local source-candidate
gate, but it does not test a deployed API, remote source reachability, EAS,
signing, or device accessibility.

## Screenshot tour

The README screenshots come from the fixture-only static demo. Rebuild and serve
it, then capture with Playwright:

~~~bash
pnpm build:demo
pnpm verify:demo:artifact
PORT=8082 node scripts/serve-pages-output.mjs dist-pages &
pnpm capture:screenshots
~~~

`scripts/capture-screenshots.mjs` writes `docs/screenshots/{desktop,mobile}/`,
overwriting existing files. Point it at a different demo with
`CONCOURSE_DEMO_URL`, and list profiles with `CONCOURSE_SCREENSHOTS` (default
`desktop,mobile`). Review the images before committing; generated output is not
a source file.

## Saved public data and recovery

The client keeps at most 50 versioned public-cache entries, within a 4 MiB total
serialized UTF-8 budget, a 1 MiB entry limit, and a 24-hour lifetime. All query
variants are eligible. Expired entries are evicted first, then the oldest write
timestamp, with key order breaking ties. Larger responses stay usable online.
Language, appearance, and unrelated storage values sit outside this cache.

Clearing saved data cancels pending public loads, clears the memory and detail
caches, and waits for queued public-storage deletion. Information already on
screen stays there, and clearing does not fetch a replacement. Navigation,
explicit refresh, and eligible recovery can load and save data again. Storage
failures do not prevent valid network data from appearing. Offline availability
reflects valid, unexpired saved responses even before an offline fallback has
happened.

Reconnect revalidates saved or transiently failed resources. Foreground and
route focus also revalidate network data older than 60 seconds, and transition
bursts coalesce within 750 ms. Institution mismatch, invalid responses, and the
fixture-only demo do not trigger automatic recovery.

## Container shutdown

SIGINT and SIGTERM stop new connections and close idle connections. Active
requests have 10 seconds to finish, then connections are force-closed and the
cache is cleaned up once. Configure a stop allowance of at least 15 seconds, for
example `docker stop --time 15` or Compose `stop_grace_period: 15s`.

## Troubleshooting

| Symptom | Check |
|---|---|
| API exits at startup | Use a known `INSTITUTION_ID`; inspect configuration validation. |
| Client cannot reach the API | Set a reachable `EXPO_PUBLIC_BFF_BASE_URL`; check port and CORS. |
| Institution mismatch | Use the same `INSTITUTION_ID` in the API and client configuration. |
| Route returns 404 | Check that the selected pack has the corresponding public sources or rooms. |
| Data is degraded | Inspect API logs and fetch the configured public source from the API host. |
| Shared client rate-limit bucket | Use exact `BFF_TRUSTED_PROXIES`; avoid `always` on exposed APIs. If many clients must share one address, raise `BFF_RATE_LIMIT_MAX`. |
| Frozen install fails | Run `pnpm install` only after an intentional dependency change, and review the lockfile. |

Use `x-request-id` to connect client-visible failures with structured API logs.
Do not put source URLs that contain sensitive material, tokens, or personal data
into issues, logs, or test inputs.
