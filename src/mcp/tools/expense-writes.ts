import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MilltimeClient } from "../../client.ts";
import {
  createExpense,
  deleteExpense,
  planCreateExpense,
  planDeleteExpense,
  planUpdateExpense,
  updateExpense,
} from "../../endpoints/expense-writes.ts";
import type { ExpenseChanges, NewExpense, Receipt } from "../../endpoints/expense-writes.ts";
import { listCurrencies, listExpenseProjects, listExpenseTypes } from "../../endpoints/reference.ts";
import { confirmedWrite } from "../confirm.ts";
import type { McpContext } from "../context.ts";
import { errorResult, handleErrors } from "../result.ts";
import { confirmToken, date, optionalDate } from "../schemas.ts";

const RECEIPT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
};

const amount = z.number().positive().describe("Including VAT, in the expense's currency");
const vat = z.number().nonnegative().describe("VAT amount, if the receipt shows it");
const note = z.string();
const receiptPath = z.string().describe(`Absolute path to a receipt file: ${Object.keys(RECEIPT_TYPES).join(", ")}`);
const expenseRef = {
  date: date.describe("The expense's day"),
  id: z.string().describe("The expense's id, from list_expenses"),
};

async function readReceipt(path: string): Promise<Receipt> {
  const mimeType = RECEIPT_TYPES[extname(path).toLowerCase()];
  if (!mimeType) throw new Error(`Unsupported receipt "${path}". Use ${Object.keys(RECEIPT_TYPES).join(", ")}.`);
  return { name: basename(path), mimeType, data: await readFile(path) };
}

/** Looks up the type, currency and project ids, so a wrong id fails before anything is planned. */
async function resolveNewExpense(
  client: MilltimeClient,
  input: Omit<NewExpense, "type" | "currency">,
  typeId: string,
  currencyCode: string | undefined,
): Promise<NewExpense> {
  const [types, currencies, projects] = await Promise.all([
    listExpenseTypes(client),
    listCurrencies(client),
    listExpenseProjects(client),
  ]);
  const type = types.find((t) => t.id === typeId);
  if (!type) throw new Error(`No expense type with id "${typeId}". Call list_expense_types to list them.`);
  const currency = currencyCode
    ? currencies.find((c) => c.code === currencyCode.toUpperCase())
    : currencies.find((c) => c.isHomeCurrency);
  if (!currency) throw new Error(`Unknown currency "${currencyCode}". Call list_currencies to list them.`);
  if (!projects.some((p) => p.id === input.projectId)) {
    throw new Error(`No expense project with id "${input.projectId}". Call list_expense_projects to list them.`);
  }
  return { ...input, type, currency };
}

export function registerExpenseWriteTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    "create_expense",
    {
      description:
        "Add an expense (utlägg), optionally with a receipt file. Ask the user for the type, project and amount " +
        "rather than assume.",
      inputSchema: {
        date: optionalDate("The day of the purchase"),
        typeId: z.string().describe("From list_expense_types"),
        projectId: z.string().describe("From list_expense_projects"),
        amount,
        currency: z.string().optional().describe("Code from list_currencies; default the home currency"),
        vat: vat.optional(),
        note: note.optional(),
        receiptPath: receiptPath.optional(),
        confirmToken,
      },
      annotations: { destructiveHint: false },
    },
    ({ date, typeId, projectId, amount, currency, vat, note, receiptPath, confirmToken: token }) =>
      handleErrors(async () => {
        const receipt = receiptPath === undefined ? undefined : await readReceipt(receiptPath);
        const input = { date: date ?? ctx.today(), projectId, amount, vat, note, receipt };
        return ctx.withClient(async (client) => {
          const expense = await resolveNewExpense(client, input, typeId, currency);
          const plan = await planCreateExpense(client, expense);
          return confirmedWrite(ctx, "create_expense", token, [plan], () => createExpense(client, expense));
        });
      }),
  );

  server.registerTool(
    "update_expense",
    {
      description: "Change an expense, or add or remove its receipts.",
      inputSchema: {
        ...expenseRef,
        newDate: date.optional().describe("Move the expense to this day"),
        projectId: z.string().optional().describe("From list_expense_projects"),
        amount: amount.optional(),
        vat: vat.optional(),
        note: note.optional(),
        addReceiptPath: receiptPath.optional(),
        removeReceipts: z.boolean().optional().describe("Remove the attached receipts"),
        confirmToken,
      },
    },
    ({ date, id, newDate, projectId, amount, vat, note, addReceiptPath, removeReceipts, confirmToken: token }) =>
      handleErrors(async () => {
        const changes: ExpenseChanges = {
          date: newDate,
          projectId,
          amount,
          vat,
          note,
          addReceipt: addReceiptPath === undefined ? undefined : await readReceipt(addReceiptPath),
          removeReceipts: removeReceipts || undefined,
        };
        if (Object.values(changes).every((value) => value === undefined)) return errorResult("Nothing to change.");
        const expense = { id, date };
        return ctx.withClient(async (client) => {
          const plan = await planUpdateExpense(client, expense, changes);
          return confirmedWrite(ctx, "update_expense", token, [plan], () => updateExpense(client, expense, changes));
        });
      }),
  );

  server.registerTool(
    "delete_expense",
    {
      description: "Delete an expense and its receipts.",
      inputSchema: { ...expenseRef, confirmToken },
      annotations: { destructiveHint: true },
    },
    ({ date, id, confirmToken: token }) =>
      handleErrors(() =>
        ctx.withClient(async (client) => {
          const expense = { id, date };
          const plan = await planDeleteExpense(client, expense);
          return confirmedWrite(ctx, "delete_expense", token, [plan], () => deleteExpense(client, expense));
        }),
      ),
  );
}
