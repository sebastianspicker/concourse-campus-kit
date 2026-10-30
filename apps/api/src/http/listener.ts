import type { IncomingMessage, ServerResponse } from "node:http";
import { PublicResponseHeader, PublicRoute, type PublicDataRoute } from "@concourse/contracts";
import type { PublicDataSources } from "../application/publicSources";
import type { BffConfig } from "../runtime/config";
import { loadInstitutionPack, type InstitutionPack } from "../runtime/institution";
import { log } from "../runtime/logger";
import { guardAuth, isInvalidAuthAttempt } from "../security/auth";
import { getCorsHeaders } from "../security/cors";
import { resolveForwardedClientKey } from "../security/forwardedIdentity";
import { guardSecurityHeaders } from "../security/headers";
import { createRateLimiter, type RateLimiter } from "../security/rateLimit";
import { handleHealth } from "./health";
import { createDataRouteHandlers, sendLoggedError, type DataRouteHandlers } from "./routes";
import { getRequestId, guardMethods, setRequestIdHeader } from "./respond";

type InstitutionLoader = (institutionId: string) => InstitutionPack;
type InstitutionLoadFailure = { status: number; code: string; publicMessage: string };

export type RequestListenerDependencies = {
  config: BffConfig;
  publicDataSources?: PublicDataSources;
  now?: Date;
  institutionLoader?: InstitutionLoader;
};

type ListenerContext = {
  config: BffConfig;
  routes: DataRouteHandlers;
  institutionLoader: InstitutionLoader;
  limiter: RateLimiter;
};

type RequestScope = {
  req: IncomingMessage;
  res: ServerResponse;
  requestId: string;
  startedAt: number;
};

const ALLOWED_METHODS = ["GET", "OPTIONS"];

function normalizeError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }

function getInstitutionLoadFailure(message: string): InstitutionLoadFailure {
  return message.includes("Unknown institutionId")
    ? { status: 404, code: "institution_not_found", publicMessage: "The requested institution is not configured" }
    : { status: 500, code: "internal_error", publicMessage: "An internal error occurred while loading configuration" };
}

function parseRequestUrl(scope: RequestScope): URL | undefined {
  const { req, res } = scope;
  if (!req.url) {
    sendLoggedError(res, 400, "bad_request", "Missing URL");
    return undefined;
  }
  try { return new URL(req.url, "http://localhost"); } catch {
    sendLoggedError(res, 400, "bad_request", "Invalid request URL");
    return undefined;
  }
}

function applyCorsHeaders(req: IncomingMessage, res: ServerResponse, config: BffConfig): void {
  for (const [key, value] of Object.entries(getCorsHeaders(req.headers.origin, config.corsOrigins))) res.setHeader(key, value);
}

function loadInstitutionForRequest(context: ListenerContext, scope: RequestScope): InstitutionPack | undefined {
  try { return context.institutionLoader(context.config.institutionId); } catch (err: unknown) {
    const error = normalizeError(err);
    log("error", "institution_load_failed", { requestId: scope.requestId, message: error.message, stack: error.stack });
    const failure = getInstitutionLoadFailure(error.message);
    sendLoggedError(scope.res, failure.status, failure.code, failure.publicMessage);
    return undefined;
  }
}

async function handleDataRoute(context: ListenerContext, scope: RequestScope, path: string): Promise<void> {
  const { req, res, requestId, startedAt } = scope;
  const institution = loadInstitutionForRequest(context, scope);
  if (!institution) return;
  res.setHeader(PublicResponseHeader.institutionId, institution.id);
  await context.routes[path as PublicDataRoute](req, res, institution, requestId);
  log("info", res.statusCode >= 200 && res.statusCode < 400 ? "data_route_ok" : "data_route_complete", {
    requestId, path, durationMs: Date.now() - startedAt, statusCode: res.statusCode
  });
}

function handleOptionsRequest(res: ServerResponse): void {
  res.setHeader("Allow", "GET, OPTIONS");
  res.writeHead(204);
  res.end();
}

function handleRateLimitExceeded(scope: RequestScope, path: string, retryAfter: number): void {
  scope.res.setHeader(PublicResponseHeader.retryAfter, String(retryAfter));
  sendLoggedError(scope.res, 429, "rate_limited", "Too many requests");
  log("warn", "rate_limited", { requestId: scope.requestId, path, retryAfterSeconds: retryAfter });
}

function handleNotFound(scope: RequestScope): void {
  sendLoggedError(scope.res, 404, "not_found", "Route not found");
  log("info", "not_found", { requestId: scope.requestId, durationMs: Date.now() - scope.startedAt });
}

async function handleHealthRoute(context: ListenerContext, scope: RequestScope): Promise<void> {
  await handleHealth(scope.req, scope.res, { config: context.config, institutionLoader: context.institutionLoader });
  log("info", "health_ok", { requestId: scope.requestId, durationMs: Date.now() - scope.startedAt });
}

function handleListenerError(res: ServerResponse, requestId: string, error: unknown): void {
  log("error", "handler_error", { requestId, message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
  sendLoggedError(res, 500, "internal_error", "Unexpected server error");
}

function guardRequestAccess(context: ListenerContext, scope: RequestScope, path: string): boolean {
  const { req, res, requestId } = scope;
  const { config, limiter } = context;
  const clientKey = resolveForwardedClientKey(req, { trustProxy: config.trustProxy, trustedProxyMatcher: config.trustedProxyMatcher });
  if (isInvalidAuthAttempt(req, config)) {
    const authRate = limiter.check(`auth:${clientKey}`);
    if (!authRate.allowed) { handleRateLimitExceeded(scope, path, authRate.retryAfter); return false; }
  }
  if (!guardAuth(req, res, config)) { log("info", "auth_required", { requestId, method: req.method, path }); return false; }
  const requestRate = limiter.check(`request:${clientKey}`, { limit: config.rateLimitMax, windowMs: config.rateLimitWindowSeconds * 1000 });
  if (!requestRate.allowed) { handleRateLimitExceeded(scope, path, requestRate.retryAfter); return false; }
  if (!guardMethods(req, res, ALLOWED_METHODS)) { log("info", "method_not_allowed", { requestId, method: req.method, path }); return false; }
  return true;
}

async function dispatchRequest(context: ListenerContext, scope: RequestScope): Promise<void> {
  const { req, res } = scope;
  const url = parseRequestUrl(scope);
  if (!url) return;
  applyCorsHeaders(req, res, context.config);
  guardSecurityHeaders(req, res);
  if (req.method === "OPTIONS") { handleOptionsRequest(res); return; }
  if (!guardRequestAccess(context, scope, url.pathname)) return;
  if (Object.hasOwn(context.routes, url.pathname)) { await handleDataRoute(context, scope, url.pathname); return; }
  if (url.pathname === PublicRoute.health) { await handleHealthRoute(context, scope); return; }
  handleNotFound(scope);
}

export function createRequestListener(dependencies: RequestListenerDependencies): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const context: ListenerContext = {
    config: dependencies.config,
    routes: createDataRouteHandlers(dependencies),
    institutionLoader: dependencies.institutionLoader ?? loadInstitutionPack,
    limiter: createRateLimiter()
  };
  return async (req, res): Promise<void> => {
    const requestId = getRequestId(req);
    setRequestIdHeader(res, requestId);
    const scope: RequestScope = { req, res, requestId, startedAt: Date.now() };
    try { await dispatchRequest(context, scope); } catch (error: unknown) { handleListenerError(res, requestId, error); }
  };
}
