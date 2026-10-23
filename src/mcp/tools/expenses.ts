import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getExpenseReceipts } from "../../endpoints/expense-writes.ts";
import type { ExpenseReceipt } from "../../endpoints/expense-writes.ts";
import { listExpenses } from "../../endpoints/expenses.ts";
import { listCurrencies, listExpenseProjects, listExpenseTypes } from "../../endpoints/reference.ts";
import type { McpContext } from "../context.ts";
import { rangeOrThisMonth } from "../range.ts";
import { handleErrors, jsonResult } from "../result.ts";
import { rangeInput } from "../schemas.ts";

const DATA_URI = /^data:([^;,]+);base64,(.*)$/s;

/** Images as image content, anything else (PDF) as an embedded resource. */
function receiptContent(receipt: ExpenseReceipt): CallToolResult["content"][number] {
  const [, mimeType, data] = DATA_URI.exec(receipt.dataUri) ?? [];
  if (!mimeType) return { type: "text", text: `Receipt ${receipt.id} is not a base64 data URI.` };
  if (mimeType.startsWith("image/")) return { type: "image", data, mimeType };
  return { type: "resource", resource: { uri: `milltime://receipts/${receipt.id}`, mimeType, blob: data } };
}

export function registerExpenseReadTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    "list_expenses",
    {
      description: "The user's expenses (utlägg) between two days, with ids, amounts, receipt counts and locked state.",
      inputSchema: rangeInput,
      annotations: { readOnlyHint: true },
    },
    (input) =>
      handleErrors(async () =>
        jsonResult(await ctx.withClient((client) => listExpenses(client, rangeOrThisMonth(input, ctx.today())))),
      ),
  );

  server.registerTool(
    "list_expense_types",
    {
      description: "Expense types, with VAT rules and whether they require a note.",
      annotations: { readOnlyHint: true },
    },
    () => handleErrors(async () => jsonResult(await ctx.withClient(listExpenseTypes))),
  );

  server.registerTool(
    "list_currencies",
    { description: "Currencies and their exchange rates to the home currency.", annotations: { readOnlyHint: true } },
    () => handleErrors(async () => jsonResult(await ctx.withClient(listCurrencies))),
  );

  server.registerTool(
    "list_expense_projects",
    { description: "Projects the user can put expenses on.", annotations: { readOnlyHint: true } },
    () => handleErrors(async () => jsonResult(await ctx.withClient(listExpenseProjects))),
  );

  server.registerTool(
    "get_expense_receipts",
    {
      description: "The receipts attached to an expense, as images (or PDF resources).",
      inputSchema: { expenseId: z.string().describe("From list_expenses") },
      annotations: { readOnlyHint: true },
    },
    ({ expenseId }) =>
      handleErrors(async () => {
        const receipts = await ctx.withClient((client) => getExpenseReceipts(client, expenseId));
        if (receipts.length === 0) return jsonResult([]);
        return { content: receipts.map(receiptContent) };
      }),
  );
}
