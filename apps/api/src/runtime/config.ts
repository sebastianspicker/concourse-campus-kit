import {
  createTrustedProxyMatcher,
  type TrustedProxyMatcher,
  type TrustProxyMode
} from "../security/proxyTrust";

export type { TrustProxyMode } from "../security/proxyTrust";

export type AuthRequirement = "disabled" | "required" | "invalid";

export type BffConfig = {
  port: number;
  institutionId: string;
  corsOrigins: string[];
  trustProxy: TrustProxyMode;
  trustedProxies: string[];
  trustedProxyMatcher: TrustedProxyMatcher;
  defaultCacheTtl: number;
  rruleExpansionHorizonDays: number;
  rateLimitMax: number;
  rateLimitWindowSeconds: number;
  authRequirement: AuthRequirement;
  authToken: string | undefined;
  appVersion: string;
  publicEventsMode: string;
  publicEventsDate: Date | undefined;
};

type Env = Readonly<Record<string, string | undefined>>;

function requireNonEmpty(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is required`);
  }
  return trimmed;
}

const INTEGER_PATTERN = /^-?\d+$/;

function parseIntInRange(raw: string, name: string, min: number, max: number): number {
  const trimmed = raw.trim();
  if (!INTEGER_PATTERN.test(trimmed)) {
    throw new Error(`${name} must be an integer`);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

const TRUST_PROXY_VALUES: Record<string, TrustProxyMode> = {
  always: "always",
  never: "never"
};

/** Normalizes the explicit proxy mode, defaulting to the fail-closed `never` policy. */
function parseTrustProxy(value: string | undefined): TrustProxyMode {
  if (!value) return "never";
  const normalized = value.trim().toLowerCase();
  const parsed = TRUST_PROXY_VALUES[normalized];
  if (parsed) return parsed;
  throw new Error(`Invalid BFF_TRUST_PROXY: ${value}; use never, always, or BFF_TRUSTED_PROXIES`);
}

const DEFAULT_PORT = 4000;

function parsePort(raw: string | undefined): number {
  if (!raw) return DEFAULT_PORT;
  try {
    return parseIntInRange(raw, "BFF_PORT", 1, 65_535);
  } catch {
    throw new Error(`Invalid BFF_PORT: ${raw}`);
  }
}

const CSV_SEPARATOR = ",";

function parseCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(CSV_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Enables range-based trust only when no explicit mode exists; a mode plus ranges is ambiguous, so it fails startup. */
function resolveTrustProxyMode(rawMode: string | undefined, trustedProxies: string[]): TrustProxyMode {
  const explicit = rawMode?.trim() ? rawMode : undefined;
  if (explicit === undefined) return trustedProxies.length > 0 ? "trusted" : "never";
  if (trustedProxies.length > 0) {
    throw new Error("BFF_TRUSTED_PROXIES is ignored while BFF_TRUST_PROXY is set; remove BFF_TRUST_PROXY to use the allowlist");
  }
  return parseTrustProxy(explicit);
}

const AUTH_REQUIRED_VALUES = new Set(["1", "true", "yes", "on"]);
const AUTH_DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

/** Normalizes supported truthy and falsy settings while preserving an invalid state. */
function parseAuthRequirement(value: string | undefined): AuthRequirement {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "disabled";
  if (AUTH_REQUIRED_VALUES.has(normalized)) return "required";
  if (AUTH_DISABLED_VALUES.has(normalized)) return "disabled";
  return "invalid";
}

/** Treats an unparseable fixed date as absent so callers fall back to the current time. */
function parsePublicEventsDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Parses the process environment once; auth settings stay representable so requests fail closed. */
export function loadConfig(env: Env): BffConfig {
  const trustedProxies = parseCsv(env.BFF_TRUSTED_PROXIES);
  const trustedProxyMatcher = createTrustedProxyMatcher(trustedProxies);
  return {
    port: parsePort(env.BFF_PORT),
    institutionId: requireNonEmpty(env.INSTITUTION_ID, "INSTITUTION_ID"),
    corsOrigins: parseCsv(env.CORS_ORIGINS),
    trustProxy: resolveTrustProxyMode(env.BFF_TRUST_PROXY, trustedProxies),
    trustedProxies,
    trustedProxyMatcher,
    defaultCacheTtl: parseIntInRange(env.BFF_DEFAULT_CACHE_TTL ?? "300", "BFF_DEFAULT_CACHE_TTL", 1, 86_400),
    rruleExpansionHorizonDays: parseIntInRange(env.RRULE_EXPANSION_HORIZON_DAYS ?? "90", "RRULE_EXPANSION_HORIZON_DAYS", 1, 366),
    rateLimitMax: parseIntInRange(env.BFF_RATE_LIMIT_MAX ?? "60", "BFF_RATE_LIMIT_MAX", 1, 100_000),
    rateLimitWindowSeconds: parseIntInRange(env.BFF_RATE_LIMIT_WINDOW_SECONDS ?? "60", "BFF_RATE_LIMIT_WINDOW_SECONDS", 1, 3_600),
    authRequirement: parseAuthRequirement(env.BFF_REQUIRE_AUTH),
    authToken: env.BFF_AUTH_TOKEN?.trim() || undefined,
    appVersion: env.APP_VERSION ?? env.npm_package_version ?? "development",
    publicEventsMode: env.PUBLIC_EVENTS_MODE ?? "auto",
    publicEventsDate: parsePublicEventsDate(env.PUBLIC_EVENTS_DATE)
  };
}
