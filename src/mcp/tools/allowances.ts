import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listAllowances } from "../../endpoints/allowances.ts";
import { listAllowanceProjects, listCountries } from "../../endpoints/reference.ts";
import type { McpContext } from "../context.ts";
import { rangeOrThisMonth } from "../range.ts";
import { handleErrors, jsonResult } from "../result.ts";
import { rangeInput } from "../schemas.ts";

export function registerAllowanceReadTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    "list_allowances",
    {
      description:
        "The user's allowances (traktamente) overlapping two days, day by day: country, private accommodation, meals. " +
        "Use earlier trips as templates for a new one (same destination, project, purpose), " +
        "but confirm the values with the user.",
      inputSchema: rangeInput,
      annotations: { readOnlyHint: true },
    },
    (input) =>
      handleErrors(async () =>
        jsonResult(await ctx.withClient((client) => listAllowances(client, rangeOrThisMonth(input, ctx.today())))),
      ),
  );

  server.registerTool(
    "list_countries",
    {
      description: 'Countries for allowances, by code. The default (home) country is written "domestic".',
      annotations: { readOnlyHint: true },
    },
    () => handleErrors(async () => jsonResult(await ctx.withClient(listCountries))),
  );

  server.registerTool(
    "list_allowance_projects",
    { description: "Projects the user can put allowances on.", annotations: { readOnlyHint: true } },
    () => handleErrors(async () => jsonResult(await ctx.withClient(listAllowanceProjects))),
  );
}
