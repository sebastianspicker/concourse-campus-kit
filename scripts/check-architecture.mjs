/** Enforces the deliberate workspace dependency and source-layer directions. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const checkerPath = fileURLToPath(import.meta.url);
const defaultRoot = resolve(dirname(checkerPath), "..");
const sourceExtensions = [".js", ".ts", ".tsx"];
const dependencySections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const workspaceDefinitions = [
  { name: "@concourse/contracts", directory: "packages/contracts", sourceDirectories: ["src"], allowedDependencies: [] },
  { name: "@concourse/institutions", directory: "packages/institutions", sourceDirectories: ["src"], allowedDependencies: ["@concourse/contracts"] },
  { name: "@concourse/api", directory: "apps/api", sourceDirectories: ["src"], allowedDependencies: ["@concourse/contracts", "@concourse/institutions"] },
  { name: "@concourse/client", directory: "apps/client", sourceDirectories: ["src", "app", "config"], allowedDependencies: ["@concourse/contracts", "@concourse/institutions"] },
];
const workspaceNames = new Set(workspaceDefinitions.map(({ name }) => name));
const allowedDependencies = new Map(workspaceDefinitions.map(({ name, allowedDependencies: allowed }) => [name, new Set(allowed)]));

function collectSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return collectSourceFiles(path);
      return sourceExtensions.includes(extname(entry.name)) ? [path] : [];
    })
    .sort();
}

function importedSpecifiers(path) {
  const source = readFileSync(path, "utf8");
  const specifiers = new Set();
  const staticImportPattern = /\b(?:import|export)\s+(?:type\s+)?(?:(?!;)[\s\S])*?\s+from\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g;
  const dynamicImportPattern = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(staticImportPattern)) specifiers.add(match[1] ?? match[2]);
  for (const match of source.matchAll(dynamicImportPattern)) specifiers.add(match[1]);
  return [...specifiers];
}

function existingSourcePath(candidate) {
  const candidates = [
    candidate,
    ...sourceExtensions.map((extension) => `${candidate}${extension}`),
    ...sourceExtensions.map((extension) => resolve(candidate, `index${extension}`)),
  ];
  return candidates.find((path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });
}

function workspaceForSpecifier(specifier) {
  return workspaceDefinitions.find(({ name }) => specifier === name || specifier.startsWith(`${name}/`));
}

function resolveImport(from, specifier, aliases, sourceRoots) {
  if (specifier.startsWith(".")) return existingSourcePath(resolve(dirname(from), specifier.replace(/\.js$/, "")));
  for (const [prefix, directory] of aliases) {
    if (specifier.startsWith(prefix)) return existingSourcePath(resolve(directory, specifier.slice(prefix.length)));
  }
  const workspace = workspaceForSpecifier(specifier);
  if (workspace) {
    const packagePath = specifier === workspace.name ? "index" : specifier.slice(workspace.name.length + 1);
    return existingSourcePath(resolve(sourceRoots.get(workspace.name)[0], packagePath));
  }
  return undefined;
}

function graphFor(files, aliases, sourceRoots) {
  const fileSet = new Set(files);
  const graph = new Map(files.map((file) => [file, []]));
  const imports = new Map(files.map((file) => [file, importedSpecifiers(file)]));
  const resolvedImports = [];
  for (const file of files) {
    for (const specifier of imports.get(file)) {
      const target = resolveImport(file, specifier, aliases, sourceRoots);
      resolvedImports.push({ from: file, specifier, target });
      if (target && fileSet.has(target)) graph.get(file).push(target);
    }
  }
  return { files, graph, imports, resolvedImports };
}

function findCycles(graph, displayPath) {
  const completed = new Set();
  const active = new Set();
  const stack = [];
  const cycles = new Set();
  function visit(file) {
    if (completed.has(file)) return;
    active.add(file);
    stack.push(file);
    for (const target of graph.get(file)) {
      if (active.has(target)) cycles.add([...stack.slice(stack.indexOf(target)), target].map(displayPath).join(" -> "));
      else visit(target);
    }
    stack.pop();
    active.delete(file);
    completed.add(file);
  }
  [...graph.keys()].sort().forEach(visit);
  return [...cycles].sort();
}

function readWorkspaceManifests(root) {
  return workspaceDefinitions.map((workspace) => {
    const manifestPath = resolve(root, workspace.directory, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.name !== workspace.name) throw new Error(`${relative(root, manifestPath)} must declare name ${workspace.name}`);
    const dependencies = new Set();
    for (const section of dependencySections) {
      for (const name of Object.keys(manifest[section] ?? {})) if (workspaceNames.has(name)) dependencies.add(name);
    }
    return { ...workspace, manifestPath, dependencies };
  });
}

function manifestDependencyViolations(workspaces, root) {
  const violations = [];
  for (const workspace of workspaces) {
    const expected = allowedDependencies.get(workspace.name);
    for (const name of [...workspace.dependencies].filter((name) => !expected.has(name)).sort()) {
      violations.push(`${relative(root, workspace.manifestPath)}: ${workspace.name} must not depend on ${name}`);
    }
    for (const name of [...expected].filter((name) => !workspace.dependencies.has(name)).sort()) {
      violations.push(`${relative(root, workspace.manifestPath)}: ${workspace.name} must declare ${name} in ${dependencySections.join(", ")}`);
    }
  }
  const graph = new Map(workspaces.map(({ name, dependencies }) => [name, [...dependencies]]));
  return { violations, cycles: findCycles(graph, (name) => name) };
}

function clientLayer(root, path) {
  const sourcePath = relative(resolve(root, "apps/client"), path).replaceAll("\\", "/");
  const parts = sourcePath.split("/");
  return parts[0] === "src" && parts[1] === "features" ? parts.slice(0, 3).join("/") : parts.slice(0, 2).join("/");
}

function apiModule(apiRoot, path) {
  return relative(apiRoot, path).replaceAll("\\", "/").replace(/\.[^./]+$/, "");
}

function apiLayer(apiRoot, path) {
  return apiModule(apiRoot, path).split("/")[0];
}

function isFeatureLayer(layer) {
  return layer.startsWith("src/features/");
}

function isForbiddenClientTarget(layer, exactLayers, includeFeatures = false) {
  return exactLayers.includes(layer) || (includeFeatures && isFeatureLayer(layer));
}

const CLIENT_BOUNDARY_RULES = [
  { source: "src/platform", target: (layer) => isForbiddenClientTarget(layer, ["src/data", "src/design-system", "src/localization", "src/shell"], true), message: "platform must not import" },
  { source: "src/data", target: (layer) => isForbiddenClientTarget(layer, ["src/design-system", "src/shell", "src/localization"], true), message: "data must not import" },
  { source: "src/design-system", target: (layer) => isForbiddenClientTarget(layer, ["src/shell", "src/data"], true), message: "design-system must not import" },
  { source: "src/localization", target: (layer) => isForbiddenClientTarget(layer, ["src/shell", "src/design-system", "src/data"], true), message: "localization must not import" },
];

function clientBoundaryMessage(fromLayer, toLayer) {
  const rule = CLIENT_BOUNDARY_RULES.find((candidate) => candidate.source === fromLayer && candidate.target(toLayer));
  return rule ? `${rule.message} ${toLayer}` : undefined;
}

function clientBoundaryViolations(root, graph) {
  const violations = [];
  for (const [from, targets] of graph) {
    const fromLayer = clientLayer(root, from);
    for (const to of targets) {
      const toLayer = clientLayer(root, to);
      const boundary = clientBoundaryMessage(fromLayer, toLayer);
      if (boundary) violations.push(`${relative(root, from)}: ${boundary}`);
      if (isFeatureLayer(fromLayer) && isFeatureLayer(toLayer) && fromLayer !== toLayer) violations.push(`${relative(root, from)}: feature-to-feature import ${relative(root, to)}`);
    }
  }
  return violations;
}

const API_FORBIDDEN_TARGETS = {
  application: ["http", "runtime", "security", "sources", "server"],
  sources: ["application", "http", "security", "server"],
  runtime: ["application", "http", "security", "sources", "server"],
  security: ["application", "sources", "server"],
  http: ["server"],
};
const API_RESPOND_MODULE = "http/respond";
const API_CONFIG_MODULE = "runtime/config";
const API_CONFIG_SECURITY_TARGET = "security/proxyTrust";
const API_ENV_MODULES = [API_CONFIG_MODULE, "server"];

function isAllowedApiImport(fromModule, toModule) {
  return fromModule === API_CONFIG_MODULE && toModule === API_CONFIG_SECURITY_TARGET;
}

function apiLayerViolation(fromModule, toModule) {
  const fromLayer = fromModule.split("/")[0];
  const toLayer = toModule.split("/")[0];
  if (fromModule === API_RESPOND_MODULE && fromModule !== toModule) return `${API_RESPOND_MODULE} must not import ${toModule}`;
  if (fromLayer === "security" && toLayer === "http" && toModule !== API_RESPOND_MODULE) return `security may import only ${API_RESPOND_MODULE} from http, not ${toModule}`;
  if (isAllowedApiImport(fromModule, toModule)) return undefined;
  if (fromLayer !== toLayer && (API_FORBIDDEN_TARGETS[fromLayer] ?? []).includes(toLayer)) return `${fromLayer} must not import ${toLayer}`;
  return undefined;
}

const nodeBuiltins = new Set(builtinModules);

function isNodeBuiltin(specifier) {
  return specifier.startsWith("node:") || nodeBuiltins.has(specifier.split("/")[0]);
}

function applicationSourceViolations(root, from, specifiers) {
  const violations = specifiers.filter(isNodeBuiltin).map((specifier) => `${relative(root, from)}: application must not import Node globals (${specifier})`);
  if (/\bprocess\s*\.\s*env\b/.test(readFileSync(from, "utf8"))) violations.push(`${relative(root, from)}: application must not access process.env`);
  return violations;
}

function apiEnvViolations(root, apiRoot, from) {
  const module = apiModule(apiRoot, from);
  if (/\.test$/.test(module) || module.split("/")[0] === "application" || API_ENV_MODULES.includes(module)) return [];
  const reads = /\bprocess\s*\.\s*env\b/.test(readFileSync(from, "utf8"));
  return reads ? [`${relative(root, from)}: only ${API_CONFIG_MODULE} and server may access process.env`] : [];
}

function apiBoundaryViolations(root, apiRoot, graph, imports) {
  const violations = [];
  for (const [from, targets] of graph) {
    const fromModule = apiModule(apiRoot, from);
    for (const to of targets) {
      const boundary = apiLayerViolation(fromModule, apiModule(apiRoot, to));
      if (boundary) violations.push(`${relative(root, from)}: ${boundary}`);
    }
    if (apiLayer(apiRoot, from) === "application") violations.push(...applicationSourceViolations(root, from, imports.get(from)));
    violations.push(...apiEnvViolations(root, apiRoot, from));
  }
  return violations;
}

function workspaceForSource(path, sourceRoots) {
  return workspaceDefinitions.find(({ name }) => sourceRoots.get(name).some((directory) => path === directory || path.startsWith(`${directory}/`)));
}

function workspaceImportViolations(root, resolvedImports, sourceRoots, manifestDependencies) {
  const violations = [];
  for (const { from, specifier, target } of resolvedImports) {
    const fromWorkspace = workspaceForSource(from, sourceRoots);
    if (!fromWorkspace) continue;
    const packageWorkspace = workspaceForSpecifier(specifier);
    if (packageWorkspace) {
      if (!allowedDependencies.get(fromWorkspace.name).has(packageWorkspace.name)) {
        violations.push(`${relative(root, from)}: ${fromWorkspace.name} must not import ${packageWorkspace.name}`);
      }
      if (!manifestDependencies.get(fromWorkspace.name).has(packageWorkspace.name)) {
        violations.push(`${relative(root, from)}: ${fromWorkspace.name} imports ${packageWorkspace.name} without a manifest dependency`);
      }
    }
    if (specifier.startsWith(".") && target) {
      const targetWorkspace = workspaceForSource(target, sourceRoots);
      if (targetWorkspace && targetWorkspace.name !== fromWorkspace.name) {
        violations.push(`${relative(root, from)}: direct relative cross-workspace source import ${relative(root, target)}`);
      }
    }
  }
  return violations;
}

export function checkArchitecture(root = defaultRoot) {
  const sourceRoots = new Map(workspaceDefinitions.map((workspace) => [workspace.name, workspace.sourceDirectories.map((directory) => resolve(root, workspace.directory, directory))]));
  const workspaces = readWorkspaceManifests(root);
  const manifestDependencies = new Map(workspaces.map(({ name, dependencies }) => [name, dependencies]));
  const apiRoot = sourceRoots.get("@concourse/api")[0];
  const clientRoots = sourceRoots.get("@concourse/client");
  const sharedRoots = [...sourceRoots.get("@concourse/contracts"), ...sourceRoots.get("@concourse/institutions")];
  const api = graphFor([apiRoot].flatMap(collectSourceFiles), [], sourceRoots);
  const client = graphFor(clientRoots.flatMap(collectSourceFiles), [["@/", resolve(root, "apps/client/src")]], sourceRoots);
  const allSources = graphFor([apiRoot, ...clientRoots, ...sharedRoots].flatMap(collectSourceFiles), [["@/", resolve(root, "apps/client/src")]], sourceRoots);
  const manifest = manifestDependencyViolations(workspaces, root);
  const violations = [
    ...manifest.violations,
    ...clientBoundaryViolations(root, client.graph),
    ...apiBoundaryViolations(root, apiRoot, api.graph, api.imports),
    ...workspaceImportViolations(root, allSources.resolvedImports, sourceRoots, manifestDependencies),
  ].sort();
  return {
    apiFiles: api.files.length,
    clientFiles: client.files.length,
    sharedFiles: sharedRoots.flatMap(collectSourceFiles).length,
    cycles: [...findCycles(allSources.graph, (path) => relative(root, path)), ...manifest.cycles],
    violations,
  };
}

export function formatArchitectureResult(result) {
  const messages = [];
  if (result.cycles.length > 0) messages.push(`Import cycles:\n${result.cycles.map((cycle) => `  ${cycle}`).join("\n")}`);
  if (result.violations.length > 0) messages.push(`Architecture violations:\n${result.violations.map((violation) => `  ${violation}`).join("\n")}`);
  return messages.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === checkerPath) {
  const result = checkArchitecture();
  if (result.cycles.length > 0 || result.violations.length > 0) {
    console.error(formatArchitectureResult(result));
    process.exitCode = 1;
  } else {
    console.log(`OK: architecture check passed (${result.apiFiles} API, ${result.clientFiles} client, and ${result.sharedFiles} shared modules).`);
  }
}
