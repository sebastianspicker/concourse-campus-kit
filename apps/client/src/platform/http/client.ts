/** Fetches typed BFF JSON with institution headers, timeouts, retries, and response metadata. */
import { getBffBaseUrl } from "@/platform/env/env";
import { isDevelopmentBffEnvironment } from "@/platform/env/bffConfig";
import { getConfiguredInstitutionId } from "@/platform/env/institution";
import { PublicResponseHeader } from "@concourse/contracts";
import { fetchJsonResponseWithTimeout } from "./fetchHelpers";
import { ApiErrorException } from "./errors";
import { withRetry } from "./retry";

// Attempts, waits, and retries together finish within this budget, below the
// 15 s cache-coordinator deadline, so the real failure (rate limit, server
// error, timeout) reaches the saved-data fallback and the UI.
const REQUEST_BUDGET_MS = 12_000;
const ATTEMPT_TIMEOUT_MS = 10_000;

export type ApiJsonResult<T> = {
  data: T;
  institutionId: string | null;
};

/** Checks that a response belongs to the configured institution before exposing its data. */
function getResponseInstitutionId(response: { headers: Headers }): string | null {
  const institutionId = response.headers.get(PublicResponseHeader.institutionId);
  const configuredInstitutionId = getConfiguredInstitutionId();
  const institutionHeaderMustMatch = institutionId !== null || !isDevelopmentBffEnvironment();
  if (institutionHeaderMustMatch && institutionId !== configuredInstitutionId) {
    throw new ApiErrorException({
      status: 409,
      code: "institution_mismatch",
      message: "App and data service institution IDs do not match",
    });
  }

  return institutionId;
}

/** Resolves only paths that remain within the previously validated BFF origin. */
function createBffRequestUrl(path: string): string {
  const baseUrl = new URL(getBffBaseUrl());
  const requestUrl = new URL(path, baseUrl);
  if (requestUrl.origin !== baseUrl.origin) {
    throw new Error("BFF request path must remain within the configured origin");
  }
  return requestUrl.toString();
}

/** Wraps the parsed payload with response metadata needed by callers. */
export async function getJsonResult<T>(
  path: string,
  parse?: (data: unknown) => T,
  options?: { signal?: AbortSignal }
): Promise<ApiJsonResult<T>> {
  const url = createBffRequestUrl(path);
  const deadline = Date.now() + REQUEST_BUDGET_MS;
  const response = await withRetry(
    () => fetchJsonResponseWithTimeout<unknown>(url, { signal: options?.signal }, Math.max(1, Math.min(ATTEMPT_TIMEOUT_MS, deadline - Date.now()))),
    { signal: options?.signal, deadline }
  );
  const institutionId = getResponseInstitutionId(response);

  return {
    data: parse ? parse(response.data) : (response.data as T),
    institutionId
  };
}
