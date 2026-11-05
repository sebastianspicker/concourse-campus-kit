# Deploy the API

`apps/api` is the Node.js BFF for public campus data. Its production Dockerfile
builds the contracts, institution packs, and API, then runs as a non-root user
under `dumb-init`.

Build a local candidate from the repository root:

~~~bash
docker build -f apps/api/Dockerfile.prod \
  --build-arg APP_VERSION=local \
  -t concourse-api:local .
~~~

Run it with a public institution pack:

~~~bash
docker run --rm --stop-timeout 15 -p 4000:4000 \
  -e INSTITUTION_ID=example \
  -e BFF_PORT=4000 \
  concourse-api:local
~~~

Request `GET /health` before publishing. To test a custom port, publish and set
the same internal port, for example `-p 4100:4100 -e BFF_PORT=4100`.

## Production controls

- Supply `INSTITUTION_ID` and production `CORS_ORIGINS` through deployment
  configuration. Keep auth tokens in secret storage, never in pack data or image
  layers.
- The health check can send `BFF_AUTH_TOKEN` when the optional bearer guard is
  enabled. `/health` does not prove that external sources are reachable.
- Leave `BFF_TRUST_PROXY` unset (it defaults to `never`) unless the network
  boundary has been reviewed. Behind a reverse proxy, set exact
  `BFF_TRUSTED_PROXIES` IP/CIDR values and keep `BFF_TRUST_PROXY` unset: the API
  refuses to start when both are set. `always` is unsafe for an exposed API
  unless a trusted edge replaces forwarding headers.
- Confirm the source URLs are public and reachable from the deployed API host.
  Do not deploy credentials or protected-source configuration with this
  repository.

## Packaging and verification

Both Dockerfiles build with pnpm 9.15.0. They install manifests before copying
source, so source-only changes can reuse the dependency layer. The build copies
`scripts/clean-package-dist.mjs`, compiles the shared packages and the API, then
runs `pnpm --filter @concourse/api deploy --prod /app` to collect the runtime and
its full dependency closure. The runtime starts in `/app` with
`node dist/server.js`; the API and shared-package allowlists include `dist`.

Run `pnpm verify:containers` before merge. It builds and smoke-tests both images
without campus services. To check an already-built image, run
`node scripts/smoke-api-image.mjs IMAGE EXPECTED_VERSION`, the same helper the
release workflow uses.

Allow at least 15 seconds for container shutdown. On SIGINT or SIGTERM the
service stops accepting connections and closes idle sockets, gives active
requests 10 seconds, then force-closes the rest and cleans up cache-owned work
exactly once.
