/** Enforces optional bearer-token protection for BFF requests. */

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendError } from "../http/respond";
import type { BffConfig } from "../runtime/config";

export type AuthConfig = Pick<BffConfig, "authRequirement" | "authToken">;

/** Extracts and trims a Bearer credential, returning empty text for malformed headers. */
function getBearerToken(req: IncomingMessage): string {
  const authHeader = req.headers["authorization"];
  if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
    return "";
  }
  return authHeader.slice("Bearer ".length).trim();
}

/** Compares bearer secrets through fixed-length digests to avoid prefix timing leakage. */
function bearerTokensEqual(actual: string, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

/**
 * Fails startup when optional authentication is configured incompletely.
 *
 * The request guard repeats these checks so every request fails closed.
 */
export function validateAuthConfiguration(config: AuthConfig): void {
  if (config.authRequirement === "invalid") {
    throw new Error("BFF_REQUIRE_AUTH has an invalid value");
  }

  if (config.authRequirement === "required" && !config.authToken) {
    throw new Error("BFF_AUTH_TOKEN is required when BFF_REQUIRE_AUTH enables authentication");
  }
}

/** Whether this request should consume the invalid-credential rate-limit bucket. */
export function isInvalidAuthAttempt(req: IncomingMessage, config: AuthConfig): boolean {
  if (config.authRequirement !== "required") return false;
  return config.authToken ? !bearerTokensEqual(getBearerToken(req), config.authToken) : false;
}

/** Rejects unauthenticated requests when bearer-token protection is enabled. */
export function guardAuth(req: IncomingMessage, res: ServerResponse, config: AuthConfig): boolean {
  if (config.authRequirement === "disabled") return true;
  if (config.authRequirement === "invalid") {
    sendError(res, 500, "auth_misconfigured", "BFF_REQUIRE_AUTH has an invalid value");
    return false;
  }

  const expectedToken = config.authToken;
  if (!expectedToken) {
    // Fail closed for private forks: enabling auth without a token is a
    // deployment error, not a reason to serve public data unauthenticated.
    sendError(res, 500, "auth_misconfigured", "Authentication is required but no token is configured");
    return false;
  }

  if (bearerTokensEqual(getBearerToken(req), expectedToken)) {
    return true;
  }

  sendError(res, 401, "unauthorized", "Authentication required");
  return false;
}
