# Release process

A source candidate is not a published release. A manually dispatched workflow validates an existing tag,
creates a GitHub Release, and publishes a verified API image in separate jobs.
Check both GitHub Releases and GHCR after every run.

## Versioning

Concourse uses Semantic Versioning. Prereleases use `X.Y.Z-alpha.N`,
`X.Y.Z-beta.N`, or `X.Y.Z-rc.N`. Publishing an existing version tag creates a versioned
`ghcr.io/<owner>/<repo>/bff` image, and stable versions also move `latest`. Do not
reuse or move a published tag.

The root manifest, `apps/api`, `apps/client`, `packages/contracts`, and
`packages/institutions` all share one SemVer version. `apps/client/app.config.ts`
uses the numeric `X.Y.Z` base, and EAS manages native build numbers remotely.

## Prepare a candidate

1. Update the five package versions and the client Expo base version.
2. Add a dated, non-empty `CHANGELOG.md` section for the exact version.
3. Run the source gate on the exact commit:

~~~bash
corepack pnpm@9.15.0 install --frozen-lockfile
pnpm release:check -- X.Y.Z-alpha.N
pnpm verify
~~~

4. Review the public docs and the static-demo evidence, plus manual native and
   accessibility evidence when distribution is in scope.
5. After explicit publication approval, create an annotated tag from the reviewed
   commit and push it:

~~~bash
git tag -a vX.Y.Z-alpha.N -m "Concourse Campus Kit X.Y.Z-alpha.N"
git push origin vX.Y.Z-alpha.N
~~~

6. From the GitHub Actions **Release** page, select `main` and dispatch the
   workflow with the existing tag (for example `vX.Y.Z-alpha.N`). Pushing a
   branch or tag alone does not publish anything.

## Publication and recovery

The workflow validates the version and changelog, runs the source gate, builds
and health-smoke-tests `apps/api/Dockerfile.prod` on a non-default port, pushes
the image, and creates the GitHub Release. It does not build mobile binaries.

If publication only partly succeeds, leave the published tag in place while you
investigate, and do not retag it. If a source fix is needed, publish the next
prerelease or patch version.

## Client distribution

The adopting institution owns the EAS project, bundle and package identifiers,
signing, the public API URL, store records, and device checks. See
[client deployment](deploy/mobile.md). EAS builds are not part of `pnpm verify`.
