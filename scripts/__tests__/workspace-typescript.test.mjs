import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifests = ["package.json", "apps/api/package.json", "apps/client/package.json", "packages/contracts/package.json", "packages/institutions/package.json"];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Builds must not depend on a global TypeScript: container builders and fresh machines have none.
test("every TypeScript compiler a workspace script calls is a bin of the workspace typescript package", () => {
  const typescriptManifest = createRequire(resolve(root, "package.json")).resolve("typescript/package.json");
  const provided = new Set(Object.keys(readJson(typescriptManifest).bin ?? {}));
  const calls = manifests.flatMap((manifest) =>
    Object.entries(readJson(resolve(root, manifest)).scripts ?? {}).flatMap(([name, script]) =>
      [...script.matchAll(/(?:^|&&\s*|;\s*)(tsc\w*)\b/g)].map((match) => ({ manifest, name, bin: match[1] }))
    )
  );

  assert.ok(calls.length > 0, "expected build or typecheck scripts that call the TypeScript compiler");
  for (const call of calls) {
    assert.ok(provided.has(call.bin), `${call.manifest} script "${call.name}" calls ${call.bin}, which the workspace typescript package does not provide (bins: ${[...provided].join(", ")})`);
  }
});
