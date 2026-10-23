import type { PlannedRequest } from "../../planned.ts";
import type { CommandOutput } from "../commands/registry.ts";

const LONG_STRING = 120;

/** Receipts travel as base64 in the body; show their length instead. */
export function shortenLongStrings(value: unknown): unknown {
  if (typeof value === "string" && value.length > LONG_STRING) {
    return `${value.slice(0, 40)}… (${value.length} chars)`;
  }
  if (Array.isArray(value)) return value.map(shortenLongStrings);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, shortenLongStrings(v)]));
  }
  return value;
}

export function dryRunOutput(plan: PlannedRequest): CommandOutput {
  const shown = { ...plan, body: shortenLongStrings(plan.body) };
  const query = Object.entries(plan.query ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const request = `${plan.method} ${plan.path}${query ? `?${query}` : ""}`;
  const body = plan.body === undefined ? [] : [JSON.stringify(shown.body, null, 2)];
  return {
    data: { dryRun: true, ...shown },
    text: [`Dry run, nothing sent: ${plan.summary}`, request, ...body].join("\n"),
  };
}
