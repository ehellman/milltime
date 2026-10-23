import type { MilltimeClient } from "./client.ts";
import type { ApiResponse } from "./types.ts";

/** A write as it would be sent: what `--dry-run` shows, and what `sendPlanned` sends. */
export interface PlannedRequest {
  method: "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  /** One line for humans, e.g. "Report 1h Development (Company - Webshop) on 2026-10-23". */
  summary: string;
}

export function sendPlanned(client: MilltimeClient, plan: PlannedRequest): Promise<ApiResponse> {
  return client.request(plan.method, plan.path, { query: plan.query, body: plan.body });
}
