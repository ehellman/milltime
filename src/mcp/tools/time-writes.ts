import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MilltimeClient } from "../../client.ts";
import { activityKey, listProjects } from "../../endpoints/projects.ts";
import type { Activity, Project } from "../../endpoints/projects.ts";
import type { NewTimeRow } from "../../endpoints/time.ts";
import type { TimeRow } from "../../endpoints/time-row.ts";
import {
  deleteTimeRow,
  planDeleteTimeRow,
  planReportTime,
  planUpdateTimeRow,
  reportTime,
  updateTimeRow,
} from "../../endpoints/time.ts";
import { confirmedWrite } from "../confirm.ts";
import type { McpContext } from "../context.ts";
import { errorResult, handleErrors } from "../result.ts";
import { confirmToken, date } from "../schemas.ts";

const hours = z.number().positive().describe("Decimal hours, e.g. 7.5");
const note = z.string().describe("Shown on the row; some activities require one");
const rowRef = {
  date: date.describe("The row's day"),
  rowId: z.string().describe("The row's id, from get_week"),
};

function findActivity(projects: Project[], key: string): Activity {
  const matches = projects.flatMap((project) => project.activities).filter((a) => activityKey(a) === key);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`No activity with key "${key}". Call list_projects to list them.`);
  const names = matches.map((a) => `${a.name} (${a.project.name})`).join(", ");
  throw new Error(`Activity key "${key}" matches several activities: ${names}.`);
}

const newRow = z.object({
  date,
  activityKey: z.string().describe("The activity's key from list_projects"),
  hours,
  note: note.optional(),
});

function describeNewRow(row: NewTimeRow): string {
  return `${row.hours}h ${row.activity.name} on ${row.date}`;
}

/** Sends rows one by one; on a failure, says which rows were sent so they are not sent twice. */
async function reportRows(client: MilltimeClient, rows: NewTimeRow[]): Promise<TimeRow[]> {
  const reported: TimeRow[] = [];
  for (const row of rows) {
    try {
      reported.push(await reportTime(client, row));
    } catch (error) {
      const sent = rows.slice(0, reported.length).map(describeNewRow);
      const unsent = rows.slice(reported.length).map(describeNewRow);
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        [
          `Reporting ${describeNewRow(row)} failed: ${reason}`,
          `Reported: ${sent.join("; ") || "nothing"}. Not reported: ${unsent.join("; ")}.`,
          "Do not send the reported rows again.",
        ].join("\n"),
      );
    }
  }
  return reported;
}

export function registerTimeWriteTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    "report_time",
    {
      description:
        "Report hours on activities, including absence (vacation, sick leave, flex): one row or a whole week in one " +
        "call, previewed and confirmed together. Ask the user which activity and how many hours rather than assume.",
      inputSchema: { rows: z.array(newRow).min(1).describe("One per day and activity"), confirmToken },
      annotations: { destructiveHint: false },
    },
    ({ rows, confirmToken: token }) =>
      handleErrors(() =>
        ctx.withClient(async (client) => {
          const projects = await listProjects(client);
          const newRows = rows.map((row) => ({ ...row, activity: findActivity(projects, row.activityKey) }));
          const plans = [];
          for (const row of newRows) plans.push(await planReportTime(client, row));
          return confirmedWrite(ctx, "report_time", token, plans, () => reportRows(client, newRows));
        }),
      ),
  );

  server.registerTool(
    "update_time_row",
    {
      description: "Change the hours or note of a reported row. To remove a row, use delete_time_row.",
      inputSchema: { ...rowRef, hours: hours.optional(), note: note.optional(), confirmToken },
    },
    ({ date, rowId, hours, note, confirmToken: token }) =>
      handleErrors(async () => {
        if (hours === undefined && note === undefined) return errorResult("Nothing to change: give hours or note.");
        const row = { id: rowId, date };
        const changes = { hours, note };
        return ctx.withClient(async (client) => {
          const plan = await planUpdateTimeRow(client, row, changes);
          return confirmedWrite(ctx, "update_time_row", token, [plan], () => updateTimeRow(client, row, changes));
        });
      }),
  );

  server.registerTool(
    "delete_time_row",
    {
      description: "Delete a reported row.",
      inputSchema: { ...rowRef, confirmToken },
      annotations: { destructiveHint: true },
    },
    ({ date, rowId, confirmToken: token }) =>
      handleErrors(() =>
        ctx.withClient(async (client) => {
          const row = { id: rowId, date };
          const plan = await planDeleteTimeRow(client, row);
          return confirmedWrite(ctx, "delete_time_row", token, [plan], () => deleteTimeRow(client, row));
        }),
      ),
  );
}
