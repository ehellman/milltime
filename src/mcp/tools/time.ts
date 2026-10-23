import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getWeekSummary } from "../../endpoints/calendar.ts";
import { activityKey, listProjects } from "../../endpoints/projects.ts";
import type { Activity, Project } from "../../endpoints/projects.ts";
import type { McpContext } from "../context.ts";
import { handleErrors, jsonResult } from "../result.ts";
import { optionalDate } from "../schemas.ts";

/** Only what the model needs to pick an activity, and the key to report it with. */
function compactActivity(activity: Activity) {
  return {
    key: activityKey(activity),
    name: activity.name,
    ...(activity.timeType !== "NORMALTIME" && { timeType: activity.timeType }),
    ...(activity.absenceType !== null && { absenceType: activity.absenceType }),
    ...(activity.requiresNote && { requiresNote: true }),
  };
}

function compactProject({ id, name, number, customer, activities }: Project) {
  return { id, name, number, customer, activities: activities.map(compactActivity) };
}

export function registerTimeTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    "list_projects",
    {
      description:
        "Projects and activities the user can report time on, including absence (vacation, sick leave, flex). " +
        "Report time with an activity's key. The same name twice in a project means two planned tasks; ask the " +
        "user which one.",
      annotations: { readOnlyHint: true },
    },
    () => handleErrors(async () => jsonResult((await ctx.withClient(listProjects)).map(compactProject))),
  );

  server.registerTool(
    "get_week",
    {
      description:
        "A week's reported time per day, with row ids, scheduled hours, locked days, totals and flex balance.",
      inputSchema: { date: optionalDate("Any day in the week") },
      annotations: { readOnlyHint: true },
    },
    ({ date }) =>
      handleErrors(async () =>
        jsonResult(await ctx.withClient((client) => getWeekSummary(client, date ?? ctx.today()))),
      ),
  );
}
