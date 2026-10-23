import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getLockStatus, lockWeek, planLockWeek } from "../../endpoints/lock.ts";
import { weekRange } from "../../dates.ts";
import { confirmedWrite } from "../confirm.ts";
import type { McpContext } from "../context.ts";
import { handleErrors, jsonResult } from "../result.ts";
import { confirmToken, date, optionalDate } from "../schemas.ts";

export function registerLockTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    "get_lock_status",
    {
      description: "Whether a week is locked, and if not, what blocks locking it (missing hours and similar).",
      inputSchema: { date: optionalDate("Any day in the week") },
      annotations: { readOnlyHint: true },
    },
    ({ date }) =>
      handleErrors(async () => {
        const monday = weekRange(date ?? ctx.today()).from;
        return jsonResult(await ctx.withClient((client) => getLockStatus(client, monday)));
      }),
  );

  server.registerTool(
    "lock_week",
    {
      description:
        "Lock a week so it can be attested. CANNOT BE UNDONE: the user cannot unlock it again. Only when the user " +
        "explicitly asks to lock that week; refused while get_lock_status reports blockers.",
      inputSchema: { date: date.describe("Any day in the week"), confirmToken },
      annotations: { destructiveHint: true },
    },
    ({ date, confirmToken: token }) =>
      handleErrors(() =>
        ctx.withClient(async (client) => {
          const monday = weekRange(date).from;
          const plan = await planLockWeek(client, monday);
          return confirmedWrite(ctx, "lock_week", token, [plan], () => lockWeek(client, monday));
        }),
      ),
  );
}
