import { createHmac } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { PlannedRequest } from "../planned.ts";
import type { McpContext } from "./context.ts";
import { jsonResult, textResult } from "./result.ts";

/** Signs the requests themselves, so a token only confirms exactly what the user was shown. */
export function confirmToken(secret: Uint8Array, plans: PlannedRequest[]): string {
  const requests = JSON.stringify(plans.map((plan) => [plan.method, plan.path, plan.query ?? null, plan.body ?? null]));
  return createHmac("sha256", secret).update(requests).digest("base64url").slice(0, 22);
}

/**
 * Without a matching token, sends nothing and returns the preview and a token.
 * With it, runs `send`, which plans the same requests again and sends them.
 */
export async function confirmedWrite(
  ctx: McpContext,
  tool: string,
  token: string | undefined,
  plans: PlannedRequest[],
  send: () => Promise<unknown>,
): Promise<CallToolResult> {
  const summary = plans.map((plan) => plan.summary).join("\n");
  const expected = confirmToken(ctx.secret, plans);
  if (token === expected) return jsonResult({ done: summary, result: (await send()) ?? null });

  const changed =
    token === undefined
      ? []
      : ["The confirmToken does not match this request: it changed since the preview. Nothing was sent."];
  return textResult(
    [
      ...changed,
      "Nothing sent yet. Show the user exactly this and ask them to confirm:",
      "",
      summary,
      "",
      `When they confirm, call ${tool} again with the same arguments and confirmToken "${expected}".`,
    ].join("\n"),
  );
}
