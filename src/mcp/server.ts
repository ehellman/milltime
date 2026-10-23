import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "./context.ts";
import { registerAllowanceWriteTools } from "./tools/allowance-writes.ts";
import { registerAllowanceReadTools } from "./tools/allowances.ts";
import { registerExpenseWriteTools } from "./tools/expense-writes.ts";
import { registerExpenseReadTools } from "./tools/expenses.ts";
import { registerLockTools } from "./tools/lock.ts";
import { registerTimeWriteTools } from "./tools/time-writes.ts";
import { registerTimeTools } from "./tools/time.ts";

const INSTRUCTIONS = [
  "Milltime time reporting, expenses and allowances (traktamente) for the logged-in user.",
  "Dates are YYYY-MM-DD in the user's local time.",
  "Writes take two calls: the first sends nothing and returns a preview and a confirmToken.",
  "Show the preview to the user and call again with the token only after they confirm.",
  "Never guess a value that changes an amount or what is reported; ask the user.",
].join(" ");

export function createServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: "milltime", version: ctx.version }, { instructions: INSTRUCTIONS });
  registerTimeTools(server, ctx);
  registerTimeWriteTools(server, ctx);
  registerLockTools(server, ctx);
  registerExpenseReadTools(server, ctx);
  registerExpenseWriteTools(server, ctx);
  registerAllowanceReadTools(server, ctx);
  registerAllowanceWriteTools(server, ctx);
  return server;
}
