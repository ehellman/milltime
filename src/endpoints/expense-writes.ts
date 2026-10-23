import { z } from "zod";
import type { MilltimeClient } from "../client.ts";
import { filterQuery } from "../filters.ts";
import { sendPlanned } from "../planned.ts";
import type { PlannedRequest } from "../planned.ts";
import { getCalendar } from "./calendar.ts";
import { findRawExpense, listExpenses, toExpense } from "./expenses.ts";
import type { Expense, RawExpense } from "./expenses.ts";
import type { Currency, ExpenseType } from "./reference.ts";

const STORE_PATH = "/data/store/ExpensesReact";
const IMAGES_PATH = "/data/store/ExpenseImages";

export interface Receipt {
  name: string;
  mimeType: string; // e.g. "image/png"
  data: Uint8Array;
}

export interface ExpenseReceipt {
  id: string;
  /** "data:image/png;base64,…" as stored by Milltime. */
  dataUri: string;
}

export interface NewExpense {
  type: ExpenseType;
  projectId: string;
  date: string; // "YYYY-MM-DD"
  /** In `currency`, VAT included. */
  amount: number;
  vat?: number;
  currency: Currency;
  note?: string;
  receipt?: Receipt;
}

export interface ExpenseChanges {
  date?: string;
  projectId?: string;
  amount?: number;
  vat?: number;
  note?: string;
  addReceipt?: Receipt;
  removeReceipts?: boolean;
}

const RawImageSchema = z.object({ ExpenseImageId: z.string(), Base64: z.string() }).passthrough();

// ---------------------------------------------------------------------------
// Payload builders — mirror what the web UI sends (see tests/fixtures/expense-*.json)
// ---------------------------------------------------------------------------

function addedImageEntries(receipt: Receipt | undefined) {
  if (!receipt) return { all: [], added: [] };
  const base64 = Buffer.from(receipt.data).toString("base64");
  const fields = { added: true, ImageName: receipt.name, deleted: false };
  return {
    all: [{ Base64: `data:${receipt.mimeType};base64,${base64}`, ...fields }],
    added: [{ Base64: base64, ...fields }],
  };
}

export function buildCreatePayload(expense: NewExpense, userId: string): Record<string, unknown> {
  const images = addedImageEntries(expense.receipt);
  return {
    attestlevel: 0,
    updated: true,
    validate: true,
    allimages: images.all,
    expensetype: 1,
    representation: {},
    addedimagefiles: images.added,
    deletedimagefiles: [],
    currencycode: expense.currency.code,
    xrate: expense.currency.rate,
    userid: userId,
    foreignexpenseamt: expense.amount,
    foreignexpensevat: expense.vat ?? 0,
    expensetypeid: expense.type.id,
    hasrepresentation: false,
    requirenote: expense.type.requiresNote,
    novat: expense.type.noVat,
    notes: expense.note ?? "",
    loadingimages: false,
    projectid: expense.projectId,
    regday: expense.date,
  };
}

function inHomeCurrency(amount: number, rate: number): number {
  return Math.round(amount * rate * 100) / 100;
}

/** The list row sent back whole, minus `id`, `projectname` and `projectnr`, with the changes and receipts applied. */
export function buildUpdatePayload(
  raw: RawExpense,
  changes: ExpenseChanges,
  receipts: ExpenseReceipt[],
): Record<string, unknown> {
  const { id: _id, projectname: _name, projectnr: _nr, ...row } = raw;
  const stored = receipts.map((r) => ({ ExpenseImageId: r.id, Base64: r.dataUri }));
  const deleted = changes.removeReceipts ? stored.map((image) => ({ ...image, deleted: true })) : [];
  const added = addedImageEntries(changes.addReceipt);
  return {
    ...row,
    attestlevel: raw.attestlevel ?? 0,
    updated: true,
    validate: true,
    allimages: [...(changes.removeReceipts ? deleted : stored), ...added.all],
    deletedimagefiles: deleted,
    addedimagefiles: added.added,
    ...(changes.amount !== undefined && {
      foreignexpenseamt: changes.amount,
      expenseamt: inHomeCurrency(changes.amount, raw.xrate),
    }),
    ...(changes.vat !== undefined && {
      foreignexpensevat: changes.vat,
      expensevat: inHomeCurrency(changes.vat, raw.xrate),
    }),
    ...(changes.note !== undefined && { notes: changes.note }),
    projectid: changes.projectId ?? raw.projectid,
    regday: changes.date ?? raw.regday,
  };
}

// ---------------------------------------------------------------------------
// Checks and summaries
// ---------------------------------------------------------------------------

async function assertDayUnlocked(client: MilltimeClient, date: string): Promise<void> {
  const [day] = await getCalendar(client, { from: date, to: date });
  if (day?.locked) throw new Error(`Day ${date} is locked`);
}

async function readUnlockedExpense(client: MilltimeClient, expense: Pick<Expense, "id" | "date">): Promise<RawExpense> {
  const raw = await findRawExpense(client, expense.date, expense.id);
  if (toExpense(raw).locked) throw new Error(`Expense ${expense.id} on ${expense.date} is locked`);
  return raw;
}

function describeExpense(expense: Expense): string {
  return `${expense.amount} ${expense.currency} ${expense.type.name} (${expense.project.name}) on ${expense.date}`;
}

function describeNewExpense(expense: NewExpense): string {
  return [
    `${expense.amount} ${expense.currency.code} ${expense.type.name} on ${expense.date}, project ${expense.projectId}`,
    expense.vat !== undefined && `VAT ${expense.vat}`,
    expense.note && `note "${expense.note}"`,
    expense.receipt && `receipt ${expense.receipt.name}`,
  ]
    .filter(Boolean)
    .join(", ");
}

function describeChanges(changes: ExpenseChanges): string {
  const edits = [
    changes.date !== undefined && `date ${changes.date}`,
    changes.projectId !== undefined && `project ${changes.projectId}`,
    changes.amount !== undefined && `amount ${changes.amount}`,
    changes.vat !== undefined && `VAT ${changes.vat}`,
    changes.note !== undefined && `note "${changes.note}"`,
    changes.addReceipt && `add receipt ${changes.addReceipt.name}`,
    changes.removeReceipts && "remove receipts",
  ].filter(Boolean);
  return edits.join(", ") || "no changes";
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

export async function getExpenseReceipts(client: MilltimeClient, expenseId: string): Promise<ExpenseReceipt[]> {
  const response = await client.request("GET", IMAGES_PATH, { query: filterQuery(["ExpenseId", "=", expenseId]) });
  return z
    .array(RawImageSchema)
    .parse(response.rows ?? [])
    .map((raw) => ({ id: raw.ExpenseImageId, dataUri: raw.Base64 }));
}

export async function planCreateExpense(client: MilltimeClient, expense: NewExpense): Promise<PlannedRequest> {
  if (expense.type.representation) throw new Error(`Representation expense types are not supported: ${expense.type.name}`);
  if (expense.type.requiresNote && !expense.note) throw new Error(`Expense type ${expense.type.name} requires a note`);
  await assertDayUnlocked(client, expense.date);

  return {
    method: "POST",
    path: STORE_PATH,
    body: buildCreatePayload(expense, await client.getUserId()),
    summary: `Add expense ${describeNewExpense(expense)}`,
  };
}

/** The POST returns no id, so the new expense is found by listing the day before and after. */
export async function createExpense(client: MilltimeClient, expense: NewExpense): Promise<Expense> {
  const plan = await planCreateExpense(client, expense);
  const day = { from: expense.date, to: expense.date };
  const before = new Set((await listExpenses(client, day)).map((e) => e.id));
  await sendPlanned(client, plan);

  const created = (await listExpenses(client, day)).filter((e) => !before.has(e.id));
  if (created.length !== 1) {
    throw new Error(`Expected one new expense on ${expense.date}, found ${created.length}`);
  }
  return created[0];
}

/** Re-reads the expense and its receipts, and sends it back with the changes applied, like the web UI. */
export async function planUpdateExpense(
  client: MilltimeClient,
  expense: Pick<Expense, "id" | "date">,
  changes: ExpenseChanges,
): Promise<PlannedRequest> {
  const raw = await readUnlockedExpense(client, expense);
  const receipts = raw.hasimages ? await getExpenseReceipts(client, expense.id) : [];
  return {
    method: "PUT",
    path: STORE_PATH,
    query: filterQuery(["id", "=", expense.id]),
    body: buildUpdatePayload(raw, changes, receipts),
    summary: `Update expense ${expense.id} on ${expense.date}: ${describeChanges(changes)}`,
  };
}

export async function updateExpense(
  client: MilltimeClient,
  expense: Pick<Expense, "id" | "date">,
  changes: ExpenseChanges,
): Promise<Expense> {
  await sendPlanned(client, await planUpdateExpense(client, expense, changes));
  return toExpense(await findRawExpense(client, changes.date ?? expense.date, expense.id));
}

export async function planDeleteExpense(
  client: MilltimeClient,
  expense: Pick<Expense, "id" | "date">,
): Promise<PlannedRequest> {
  const current = toExpense(await readUnlockedExpense(client, expense));
  return {
    method: "DELETE",
    path: STORE_PATH,
    query: filterQuery(["id", "=", expense.id]),
    summary: `Delete expense ${describeExpense(current)}`,
  };
}

export async function deleteExpense(client: MilltimeClient, expense: Pick<Expense, "id" | "date">): Promise<void> {
  await sendPlanned(client, await planDeleteExpense(client, expense));
}
