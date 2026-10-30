import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";

import { checkArchitecture } from "../check-architecture.mjs";

const packageDefinitions = {
  "@concourse/contracts": { directory: "packages/contracts", dependencies: {} },
  "@concourse/institutions": { directory: "packages/institutions", dependencies: { "@concourse/contracts": "workspace:*" } },
  "@concourse/api": { directory: "apps/api", dependencies: { "@concourse/contracts": "workspace:*", "@concourse/institutions": "workspace:*" } },
  "@concourse/client": { directory: "apps/client", dependencies: { "@concourse/contracts": "workspace:*", "@concourse/institutions": "workspace:*" } },
};

function writeFixture(root, { manifests = {}, sourceFiles = {} } = {}) {
  for (const [name, definition] of Object.entries(packageDefinitions)) {
    const { directory, dependencies } = definition;
    const manifest = { name, private: true, dependencies, ...manifests[name] };
    const manifestPath = resolve(root, directory, "package.json");
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(manifest));
  }
  const defaults = {
    "packages/contracts/src/index.ts": "export {};\n",
    "packages/institutions/src/index.ts": "export {};\n",
    "apps/api/src/index.ts": "export {};\n",
    "apps/client/src/index.ts": "export {};\n",
    "apps/client/app/index.ts": "export {};\n",
    "apps/client/config/index.js": "export {};\n",
  };
  for (const [path, source] of Object.entries({ ...defaults, ...sourceFiles })) {
    const sourcePath = resolve(root, path);
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, source);
  }
}

function withFixture(options, run) {
  const root = mkdtempSync(resolve(tmpdir(), "concourse-architecture-"));
  try {
    writeFixture(root, options);
    run(checkArchitecture(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("accepts the declared workspace dependency graph", () => {
  withFixture({}, (result) => {
    assert.deepEqual(result.cycles, []);
    assert.deepEqual(result.violations, []);
  });
});

test("rejects a contracts-to-institutions package import", () => {
  withFixture({ sourceFiles: { "packages/contracts/src/index.ts": 'import {\n  institution,\n} from "@concourse/institutions";\n' } }, (result) => {
    assert.match(result.violations.join("\n"), /@concourse\/contracts must not import @concourse\/institutions/);
  });
});

test("rejects a client-to-API package import", () => {
  withFixture({ sourceFiles: { "apps/client/src/index.ts": 'import "@concourse/api";\n' } }, (result) => {
    assert.match(result.violations.join("\n"), /@concourse\/client must not import @concourse\/api/);
  });
});

test("rejects an API-to-client package import", () => {
  withFixture({ sourceFiles: { "apps/api/src/index.ts": 'import "@concourse/client";\n' } }, (result) => {
    assert.match(result.violations.join("\n"), /@concourse\/api must not import @concourse\/client/);
  });
});

test("rejects client platform imports from localization", () => {
  withFixture({ sourceFiles: {
    "apps/client/src/platform/http.ts": 'import "@/localization/dictionaries";\n',
    "apps/client/src/localization/dictionaries.ts": "export {};\n",
  } }, (result) => {
    assert.match(result.violations.join("\n"), /platform must not import src\/localization/);
  });
});

test("rejects direct relative cross-workspace source imports", () => {
  withFixture({ sourceFiles: { "packages/contracts/src/index.ts": 'import "../../institutions/src/index";\n' } }, (result) => {
    assert.match(result.violations.join("\n"), /direct relative cross-workspace source import packages\/institutions\/src\/index\.ts/);
  });
});

test("rejects a manifest-only workspace dependency cycle", () => {
  withFixture({ manifests: { "@concourse/contracts": { dependencies: { "@concourse/institutions": "workspace:*" } } } }, (result) => {
    assert.match(result.cycles.join("\n"), /@concourse\/contracts -> @concourse\/institutions -> @concourse\/contracts/);
  });
});

function apiSources(files) {
  return Object.fromEntries(Object.entries(files).map(([path, source]) => [`apps/api/src/${path}`, source]));
}

function assertApiViolation(files, pattern) {
  withFixture({ sourceFiles: apiSources(files) }, (result) => {
    assert.match(result.violations.join("\n"), pattern);
  });
}

function assertNoApiViolation(files) {
  withFixture({ sourceFiles: apiSources(files) }, (result) => {
    assert.deepEqual(result.violations, []);
  });
}

test("accepts the declared API layer imports", () => {
  assertNoApiViolation({
    "http/respond.ts": 'import "node:http";\n',
    "http/listener.ts": 'import "./respond";\nimport "../security/auth";\nimport "../runtime/config";\nimport "../sources/ics/publicSchedule";\nimport "../application/events";\n',
    "security/auth.ts": 'import "../http/respond";\nimport "../runtime/config";\n',
    "runtime/config.ts": 'import "../security/proxyTrust";\nexport {};\n',
    "security/proxyTrust.ts": "export {};\n",
    "sources/ics/publicSchedule.ts": 'import "../upstream/cache";\nimport "../../runtime/logger";\n',
    "sources/upstream/cache.ts": "export {};\n",
    "runtime/logger.ts": "export {};\n",
    "application/events.ts": "export {};\n",
    "server.ts": 'import "./http/listener";\nexport const env = process.env;\n',
  });
});

test("rejects application imports of http, runtime, security, sources and server", () => {
  for (const target of ["http/a", "runtime/a", "security/a", "sources/a", "server"]) {
    assertApiViolation({ "application/events.ts": `import "../${target}";\n`, [`${target}.ts`]: "export {};\n" }, /application must not import/);
  }
});

test("rejects application imports of Node builtins with or without the node: prefix", () => {
  for (const specifier of ["node:crypto", "crypto", "fs/promises"]) {
    assertApiViolation({ "application/events.ts": `import "${specifier}";\n` }, /application must not import Node globals/);
  }
});

test("rejects sources imports of application, http, security and server", () => {
  for (const target of ["application/a", "http/a", "security/a", "server"]) {
    assertApiViolation({ "sources/a.ts": `import "../${target}";\n`, [`${target}.ts`]: "export {};\n" }, /sources must not import/);
  }
});

test("rejects runtime imports of application, http, security, sources and server", () => {
  for (const target of ["application/a", "http/a", "security/a", "sources/a", "server"]) {
    assertApiViolation({ "runtime/logger.ts": `import "../${target}";\n`, [`${target}.ts`]: "export {};\n" }, /runtime must not import/);
  }
});

test("allows only runtime config to import the security proxy matcher", () => {
  assertApiViolation({ "runtime/logger.ts": 'import "../security/proxyTrust";\n', "security/proxyTrust.ts": "export {};\n" }, /runtime must not import security/);
});

test("rejects security imports of application, sources and server, and of http beyond respond", () => {
  for (const target of ["application/a", "sources/a", "server"]) {
    assertApiViolation({ "security/auth.ts": `import "../${target}";\n`, [`${target}.ts`]: "export {};\n" }, /security must not import/);
  }
  assertApiViolation({ "security/auth.ts": 'import "../http/routes";\n', "http/routes.ts": "export {};\n" }, /security may import only http\/respond/);
});

test("rejects http/respond imports of any other internal module", () => {
  for (const target of ["runtime/logger", "http/routes", "security/auth"]) {
    assertApiViolation({ "http/respond.ts": `import "../${target}";\n`, [`${target}.ts`]: "export {};\n" }, /http\/respond must not import/);
  }
});

test("rejects http imports of server", () => {
  assertApiViolation({ "http/listener.ts": 'import "../server";\n', "server.ts": "export {};\n" }, /http must not import server/);
});

test("rejects process.env reads outside runtime config and server", () => {
  for (const path of ["http/health.ts", "security/auth.ts", "sources/ics/publicSchedule.ts", "runtime/logger.ts", "testing/config.ts"]) {
    assertApiViolation({ [path]: "export const mode = process.env.MODE;\n" }, /only runtime\/config and server may access process\.env/);
  }
  assertApiViolation({ "http/health.ts": "export const mode = process . env.MODE;\n" }, /may access process\.env/);
});

test("permits process.env in runtime config, server and test files", () => {
  assertNoApiViolation({
    "runtime/config.ts": "export const env = process.env;\n",
    "server.ts": "export const env = process.env;\n",
    "http/listener.test.ts": "export const env = process.env;\n",
  });
});
