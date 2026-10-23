import { readFile, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { MilltimeClient } from "../../client.ts";
import {
  createExpense,
  deleteExpense,
  getExpenseReceipts,
  planCreateExpense,
  planDeleteExpense,
  planUpdateExpense,
  updateExpense,
} from "../../endpoints/expense-writes.ts";
import type { ExpenseChanges, NewExpense, Receipt } from "../../endpoints/expense-writes.ts";
import { listExpenses } from "../../endpoints/expenses.ts";
import type { Expense } from "../../endpoints/expenses.ts";
import { listCurrencies, listExpenseProjects, listExpenseTypes } from "../../endpoints/reference.ts";
import {
  optionalArg,
  optionalString,
  parseDateArg,
  parseMonthArg,
  parseNumberOption,
  parsePositiveOption,
  requiredArgs,
  requiredOption,
} from "../args.ts";
import type { CliContext } from "../context.ts";
import { UsageError } from "../errors.ts";
import { dryRunOutput } from "../format/plan.ts";
import { formatTable } from "../format/table.ts";
import { withSession } from "../session.ts";
import type { CommandGroup, CommandInput, CommandOutput } from "./registry.ts";

async function list({ positionals }: CommandInput, ctx: CliContext): Promise<CommandOutput> {
  const range = parseMonthArg(optionalArg(positionals, "month"), ctx.today());
  const all = await withSession(ctx, (client) => listExpenses(client, range));
  return { data: all, text: formatExpenses(all, range.from.slice(0, 7)) };
}

function formatExpenses(all: Expense[], month: string): string {
  if (all.length === 0) return `No expenses in ${month}.`;
  const rows = all.map((expense) => [
    expense.date,
    expense.type.name,
    expense.project.name,
    `${formatMoney(expense.amount)} ${expense.currency}`,
    formatMoney(expense.vat),
    formatMoney(expense.amountInHomeCurrency),
    expense.hasReceipt ? "yes" : "",
    expense.locked ? "yes" : "",
    expense.id,
    expense.note ?? "",
  ]);
  const total = all.reduce((sum, expense) => sum + expense.amountInHomeCurrency, 0);
  const headers = ["Date", "Type", "Project", "Amount", "VAT", "Home amount", "Receipt", "Locked", "Id", "Note"];
  const table = formatTable(headers, rows, { align: ["left", "left", "left", "right", "right", "right"] });
  return `${table}\nTotal: ${formatMoney(total)} in home currency`;
}

function formatMoney(amount: number): string {
  return amount.toFixed(2);
}

async function types(_input: CommandInput, ctx: CliContext): Promise<CommandOutput> {
  const expenseTypes = await withSession(ctx, listExpenseTypes);
  const rows = expenseTypes.map((type) => [type.name, type.id, type.requiresNote ? "yes" : "", type.noVat ? "yes" : ""]);
  return { data: expenseTypes, text: formatTable(["Type", "Id", "Requires note", "No VAT"], rows) };
}

async function currencies(_input: CommandInput, ctx: CliContext): Promise<CommandOutput> {
  const all = await withSession(ctx, listCurrencies);
  const rows = all.map((currency) => [
    currency.code,
    currency.name,
    String(currency.rate),
    currency.isHomeCurrency ? "home" : "",
  ]);
  return { data: all, text: formatTable(["Code", "Name", "Rate", ""], rows, { align: ["left", "left", "right"] }) };
}

async function projects(_input: CommandInput, ctx: CliContext): Promise<CommandOutput> {
  const expenseProjects = await withSession(ctx, listExpenseProjects);
  const rows = expenseProjects.map((project) => [project.number, project.name, project.customer, project.id]);
  return { data: expenseProjects, text: formatTable(["Number", "Project", "Customer", "Id"], rows) };
}

const RECEIPT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
};

async function readReceipt(path: string): Promise<Receipt> {
  const mimeType = RECEIPT_TYPES[extname(path).toLowerCase()];
  if (!mimeType) throw new UsageError(`Unsupported receipt "${path}". Use ${Object.keys(RECEIPT_TYPES).join(", ")}.`);
  return { name: basename(path), mimeType, data: await readFile(path) };
}

/** Looks up the type, currency and project ids, so a typo fails before anything is planned. */
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
  if (!type) throw new UsageError(`No expense type with id "${typeId}". Run "milltime expenses types" to list them.`);
  const currency = currencyCode
    ? currencies.find((c) => c.code === currencyCode.toUpperCase())
    : currencies.find((c) => c.isHomeCurrency);
  if (!currency) throw new UsageError(`Unknown currency "${currencyCode}". Run "milltime expenses currencies" to list them.`);
  if (!projects.some((p) => p.id === input.projectId)) {
    throw new UsageError(`No expense project with id "${input.projectId}". Run "milltime expenses projects" to list them.`);
  }
  return { ...input, type, currency };
}

function describeExpense(expense: Expense): string {
  return `${formatMoney(expense.amount)} ${expense.currency} ${expense.type.name} (${expense.project.name}) on ${expense.date}`;
}

async function add({ positionals, values }: CommandInput, ctx: CliContext): Promise<CommandOutput> {
  const [dateArg] = requiredArgs(positionals, ["date"]);
  const typeId = requiredOption(values.type, "type");
  const input = {
    date: parseDateArg(dateArg, ctx.today()),
    projectId: requiredOption(values.project, "project"),
    amount: parsePositiveOption(requiredOption(values.amount, "amount"), "amount")!,
    vat: parseNumberOption(values.vat, "vat"),
    note: optionalString(values.note),
    receipt: values.receipt ? await readReceipt(requiredOption(values.receipt, "receipt")) : undefined,
  };

  return withSession(ctx, async (client) => {
    const expense = await resolveNewExpense(client, input, typeId, optionalString(values.currency));
    if (values["dry-run"]) return dryRunOutput(await planCreateExpense(client, expense));
    const created = await createExpense(client, expense);
    return { data: created, text: `Added expense ${created.id}: ${describeExpense(created)}` };
  });
}

async function edit({ positionals, values }: CommandInput, ctx: CliContext): Promise<CommandOutput> {
  const [dateArg, id] = requiredArgs(positionals, ["date", "id"]);
  const expense = { id, date: parseDateArg(dateArg, ctx.today()) };
  const changes: ExpenseChanges = {
    date: values["new-date"] ? parseDateArg(requiredOption(values["new-date"], "new-date"), ctx.today()) : undefined,
    projectId: optionalString(values.project),
    amount: parsePositiveOption(values.amount, "amount"),
    vat: parseNumberOption(values.vat, "vat"),
    note: optionalString(values.note),
    addReceipt: values.receipt ? await readReceipt(requiredOption(values.receipt, "receipt")) : undefined,
    removeReceipts: values["remove-receipts"] === true || undefined,
  };
  if (Object.values(changes).every((value) => value === undefined)) {
    throw new UsageError("Nothing to change. See \"milltime expenses edit --help\".");
  }

  return withSession(ctx, async (client) => {
    if (values["dry-run"]) return dryRunOutput(await planUpdateExpense(client, expense, changes));
    const saved = await updateExpense(client, expense, changes);
    return { data: saved, text: `Updated expense ${saved.id}: ${describeExpense(saved)}` };
  });
}

async function remove({ positionals, values }: CommandInput, ctx: CliContext): Promise<CommandOutput> {
  const [dateArg, id] = requiredArgs(positionals, ["date", "id"]);
  const expense = { id, date: parseDateArg(dateArg, ctx.today()) };

  return withSession(ctx, async (client) => {
    if (values["dry-run"]) return dryRunOutput(await planDeleteExpense(client, expense));
    await deleteExpense(client, expense);
    return { data: { deleted: expense }, text: `Deleted expense ${expense.id} on ${expense.date}` };
  });
}

const DATA_URI = /^data:([^;,]+);base64,(.*)$/s;
const EXTENSIONS: Record<string, string> = { "image/jpeg": ".jpg", "application/pdf": ".pdf", "image/png": ".png", "image/gif": ".gif" };

/** Several receipts are saved as name-1.ext, name-2.ext, … */
function receiptPath(out: string, index: number, count: number, mimeType: string): string {
  const extension = extname(out) || EXTENSIONS[mimeType] || "";
  const stem = extname(out) ? out.slice(0, -extname(out).length) : out;
  return count === 1 ? `${stem}${extension}` : `${stem}-${index + 1}${extension}`;
}

async function receipt({ positionals, values }: CommandInput, ctx: CliContext): Promise<CommandOutput> {
  const [id] = requiredArgs(positionals, ["id"]);
  const out = requiredOption(values.out, "out");
  const receipts = await withSession(ctx, (client) => getExpenseReceipts(client, id));
  if (receipts.length === 0) return { data: [], text: `Expense ${id} has no receipt.` };

  const saved = [];
  for (const [index, stored] of receipts.entries()) {
    const match = DATA_URI.exec(stored.dataUri);
    if (!match) throw new Error(`Receipt ${stored.id} is not a base64 data URI`);
    const path = receiptPath(out, index, receipts.length, match[1]);
    await writeFile(path, Buffer.from(match[2], "base64"));
    saved.push({ id: stored.id, mimeType: match[1], path });
  }
  return { data: saved, text: saved.map((s) => `Saved receipt ${s.id} to ${s.path}`).join("\n") };
}

const DRY_RUN = { "dry-run": { type: "boolean" } } as const;
const DRY_RUN_HELP = "  --dry-run          Show the request without sending it";
const DATE_HELP = "  date  YYYY-MM-DD, today or yesterday";
const EXPENSE_HELP = `${DATE_HELP}\n  id    The expense's id, from "milltime expenses list"`;

export const expenses: CommandGroup = {
  summary: "Expenses and the reference data needed to report them.",
  commands: {
    list: {
      summary: "List your expenses for a month",
      usage: "[month]",
      details: "Arguments:\n  month  YYYY-MM (default: this month)",
      run: list,
    },
    types: { summary: "List expense types", run: types },
    currencies: { summary: "List currencies and exchange rates to the home currency", run: currencies },
    projects: { summary: "List projects you can report expenses on", run: projects },
    add: {
      summary: "Add an expense, optionally with a receipt",
      usage: "<date> --type <id> --project <id> --amount <n> [--vat <n>] [--currency <code>] [--note <text>] [--receipt <file>]",
      details: [
        "Arguments:",
        DATE_HELP,
        "Options:",
        '  --type             Expense type id, from "milltime expenses types"',
        '  --project          Project id, from "milltime expenses projects"',
        "  --amount           Amount including VAT, in --currency",
        "  --vat              VAT amount (default 0)",
        "  --currency         Currency code (default: the home currency)",
        "  --note             Note (required by some types)",
        "  --receipt          Receipt file: .png, .jpg, .gif or .pdf",
        DRY_RUN_HELP,
      ].join("\n"),
      options: {
        type: { type: "string" },
        project: { type: "string" },
        amount: { type: "string" },
        vat: { type: "string" },
        currency: { type: "string" },
        note: { type: "string" },
        receipt: { type: "string" },
        ...DRY_RUN,
      },
      run: add,
    },
    edit: {
      summary: "Change an expense, or add or remove its receipts",
      usage: "<date> <id> [--new-date <date>] [--project <id>] [--amount <n>] [--vat <n>] [--note <text>] [--receipt <file>] [--remove-receipts]",
      details: [
        "Arguments:",
        EXPENSE_HELP,
        "Options:",
        "  --new-date         Move the expense to another day",
        "  --project          New project id",
        "  --amount           New amount, in the expense's currency",
        "  --vat              New VAT amount",
        "  --note             New note",
        "  --receipt          Add a receipt file",
        "  --remove-receipts  Remove the existing receipts",
        DRY_RUN_HELP,
      ].join("\n"),
      options: {
        "new-date": { type: "string" },
        project: { type: "string" },
        amount: { type: "string" },
        vat: { type: "string" },
        note: { type: "string" },
        receipt: { type: "string" },
        "remove-receipts": { type: "boolean" },
        ...DRY_RUN,
      },
      run: edit,
    },
    delete: {
      summary: "Delete an expense",
      usage: "<date> <id>",
      details: ["Arguments:", EXPENSE_HELP, "Options:", DRY_RUN_HELP].join("\n"),
      options: { ...DRY_RUN },
      run: remove,
    },
    receipt: {
      summary: "Save an expense's receipts to a file",
      usage: "<id> --out <file>",
      details: [
        "Arguments:",
        '  id  The expense\'s id, from "milltime expenses list"',
        "Options:",
        "  --out  File to write; several receipts are saved as <file>-1, <file>-2, …",
      ].join("\n"),
      options: { out: { type: "string" } },
      run: receipt,
    },
  },
};
