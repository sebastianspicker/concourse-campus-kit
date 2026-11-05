import type { IncomingMessage, ServerResponse } from "node:http";

import type { BffConfig } from "../runtime/config";
import type { InstitutionPack } from "../runtime/institution";
import { log } from "../runtime/logger";

const serverStartTime = Date.now();

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export type HealthDependencies = {
  config: Pick<BffConfig, "institutionId" | "appVersion">;
  institutionLoader: (institutionId: string) => InstitutionPack;
};

export async function handleHealth(
  _req: IncomingMessage,
  res: ServerResponse,
  dependencies: HealthDependencies
): Promise<void> {
  const { config, institutionLoader } = dependencies;
  res.setHeader("Cache-Control", "no-store");

  const checks: Record<string, { status: string; message?: string }> = {};
  let overallStatus = "ok";

  try {
    institutionLoader(config.institutionId);
    checks.institutionPack = { status: "ok" };
  } catch (err: unknown) {
    overallStatus = "error";
    checks.institutionPack = {
      status: "error",
      message: "Failed to load institution pack"
    };
    log("error", "health_institution_failed", {
      message: err instanceof Error ? err.message : String(err)
    });
  }

  const response = {
    status: overallStatus,
    version: config.appVersion,
    institution: config.institutionId,
    uptime: formatUptime(Date.now() - serverStartTime),
    checks
  };

  const statusCode = overallStatus === "ok" ? 200 : 503;
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(response));
}
