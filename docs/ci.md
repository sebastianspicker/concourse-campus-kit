# Continuous integration

GitHub Actions automatically checks Dependabot pull requests and runs security
scans. Other source checks and all publication require manual dispatch.

## Workflows

| Workflow | Runs on | What it does |
|---|---|---|
| `ci` | Dependabot-authored pull requests, manual dispatch | Installs with the frozen lockfile and runs `scripts/verify-production-ready.sh`: tooling tests, a batched public-tree scan, architecture checks, and fresh package builds. The `web` and `containers` jobs must also pass before merge. |
| `dependency-review` | pull requests | Uses GitHub dependency review to reject introduced vulnerabilities, including low severity. |
| `gitleaks` | pull requests, pushes to `main`/`dev`, manual dispatch | Scans for committed secrets. |
| `codeql` | pull requests, pushes to `main`/`dev`, weekly, manual dispatch | Runs CodeQL analysis. |
| `pages` | manual dispatch from `main` only | Builds the fixture-only static demo and its design preview, then deploys the verified artifact. |
| `release` | manual dispatch from `main`, with an existing version tag | Checks metadata and the source gate, verifies the `apps/api` image, pushes it to GHCR, and creates the GitHub Release. |

Publication is two manual workflows. This diagram shows what each one produces:

~~~mermaid
flowchart LR
  main[main branch]
  tag[Existing version tag]
  subgraph releasewf [release workflow]
    validate[validate]
    image[build-bff-docker]
    rel[create-release]
  end
  subgraph pageswf [pages workflow]
    demo["build:demo + verify"]
  end
  ghcr[(GHCR bff image)]
  ghr[GitHub Release]
  site[GitHub Pages demo]
  tag -->|manual dispatch| validate
  validate -->|verify gate passed| image
  image -->|"smoke test, docker push"| ghcr
  validate --> rel
  image --> rel
  rel --> ghr
  main -->|manual dispatch| demo
  demo -->|deploy-pages| site
~~~

`validate` checks that the tag is on `main`, that versions and changelog
match, and runs `scripts/verify-production-ready.sh`. `build-bff-docker` builds
[apps/api/Dockerfile](../apps/api/Dockerfile), smoke-tests it with
[scripts/smoke-api-image.mjs](../scripts/smoke-api-image.mjs), and pushes only
after that passes. The client has no pipeline here: EAS builds and store
submission belong to the adopting institution. See
[.github/workflows/release.yml](../.github/workflows/release.yml) and
[.github/workflows/pages.yml](../.github/workflows/pages.yml).

The release workflow runs its image and release jobs separately, so publication
is not atomic. After a failed run, check GHCR and GitHub Releases independently.
Stable tags also move the `latest` tag; prerelease tags do not.

## Reproduce CI locally

~~~bash
pnpm install --frozen-lockfile
pnpm verify
pnpm exec playwright install chromium
pnpm verify:web
pnpm verify:containers
docker run --rm -v "$PWD:/repo" ghcr.io/gitleaks/gitleaks:v8.28.0 detect --redact --source=/repo --config=/repo/.gitleaks.toml
~~~

`pnpm verify` mirrors the `ci` job; set `SKIP_INSTALL=1` when the frozen install
already ran.
`pnpm verify` is not a substitute for the remote checks: OSV, Gitleaks, CodeQL,
Docker publication, Pages deployment, EAS, and native accessibility checks all
happen outside it.

The lockfile includes a narrow Metro patch in `patches/`: Metro reads image
assets as bytes before passing them to image-size 2. Both container builders
copy that patch before the frozen install. Keep the patch and lockfile aligned
when updating Metro, and verify real asset exports with `pnpm verify:web`.

## Policy

Non-Dependabot pull requests do not run the general build jobs or deploy anything.
Security scans still examine all pull requests. Dependency updates are scheduled
weekly for npm workspaces, GitHub Actions and API Docker base images. Public pull-request workflows need no secrets. Keep privileged jobs on trusted
branches or manual dispatch, pin tools and actions, and install with the frozen
lockfile. `CODEOWNERS` protects the workflow, security, release, container,
contract, and institution-pack surfaces.

## Browser and container gates

`pnpm verify:web` exports the fixture-only demo, validates the artifact, exports
the normal client with an intercepted HTTPS fixture origin, then runs pinned
Playwright 1.63.0 Chromium scenarios against both. No campus service is
required. The scenarios cover navigation, responsive rendering, cache and
recovery behavior, and demo network isolation.

For day-to-day work, `pnpm test:web` runs against a prepared demo and the normal
development server, and `CONCOURSE_WEB_BUILD=production pnpm test:web` uses the
prepared normal export. `pnpm build:web:client` rebuilds the browser-test
artifact with the example institution pack and a cleared Metro cache. Playwright
intercepts the HTTPS fixture origin, so no deployed service is involved. Set
`CONCOURSE_WEB_RESULTS` to keep results, traces, and screenshots somewhere
useful; the default is `/tmp/concourse-playwright-results`.

`pnpm verify:containers` builds both API Dockerfiles and runs the shared image
smoke helper. It checks non-root execution, compiled output, shared and external
runtime dependencies, health and version on port 4107, invalid startup settings,
and request draining. The release workflow reuses the same helper before pushing
the image.

Branch protection should require the `ci`, `web`, and `containers` jobs. Workflow
files define those jobs; applying branch protection is a separate repository
administration step. Turbo archives use a revision-specific save key and
configuration/branch restore prefixes, so new results are saved per commit.
Changes to the shared cleanup helper invalidate package tasks.
