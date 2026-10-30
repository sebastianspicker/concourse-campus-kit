import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");

// docs/release.md promises ghcr.io/<owner>/<repo>/bff; a hard-coded name drifts when the repository moves.
test("the release workflow derives the BFF image name from the repository", () => {
  const hardCoded = [...workflow.matchAll(/ghcr\.io\/[\w.-]+\/[\w.-]+\/bff/g)].map((match) => match[0]);
  assert.deepEqual(hardCoded, [], "release.yml hard-codes a GHCR image name");

  const derived = [...workflow.matchAll(/ghcr\.io\/\$\{GITHUB_REPOSITORY,,\}\/bff/g)];
  assert.ok(derived.length >= 2, "both the image job and the release summary derive the lowercased image name");
});
