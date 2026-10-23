import { z } from "zod";
import type { MilltimeClient } from "../client.ts";
import type { DateRange } from "../dates.ts";
import { dateRangeQuery } from "../filters.ts";
import { isLocked } from "./time-row.ts";

const RawExpenseSchema = z
  .object({
    expenseid: z.string(),
    regday: z.string(),
    expensetypeid: z.string(),
    expensetypename: z.string(),
    projectid: z.string(),
    projectname: z.string(),
    projectnr: z.string(),
    foreignexpenseamt: z.number(),
    foreignexpensevat: z.number(),
    currencycode: z.string(),
    xrate: z.number(),
    expenseamt: z.number(),
    notes: z.string().nullable(),
    hasimages: z.boolean(),
    attestlevel: z.number().nullable(),
  })
  .passthrough();

export type RawExpense = z.infer<typeof RawExpenseSchema>;

export interface Expense {
  id: string;
  date: string;
  type: { id: string; name: string };
  project: { id: string; name: string; number: string };
  /** Amount in `currency`, as entered. */
  amount: number;
  vat: number;
  currency: string;
  exchangeRate: number;
  /** Amount converted by Milltime (amount × exchangeRate). */
  amountInHomeCurrency: number;
  note: string | null;
  hasReceipt: boolean;
  locked: boolean;
}

export function toExpense(raw: RawExpense): Expense {
  return {
    id: raw.expenseid,
    date: raw.regday,
    type: { id: raw.expensetypeid, name: raw.expensetypename },
    project: { id: raw.projectid, name: raw.projectname, number: raw.projectnr },
    amount: raw.foreignexpenseamt,
    vat: raw.foreignexpensevat,
    currency: raw.currencycode,
    exchangeRate: raw.xrate,
    amountInHomeCurrency: raw.expenseamt,
    note: raw.notes,
    hasReceipt: raw.hasimages,
    locked: isLocked(raw.attestlevel),
  };
}

async function fetchRawExpenses(client: MilltimeClient, range: DateRange): Promise<RawExpense[]> {
  const response = await client.request("GET", "/data/store/ExpensesReact", { query: dateRangeQuery(range) });
  return z.array(RawExpenseSchema).parse(response.rows ?? []);
}

/** The list row as Milltime returns it; edits send it back whole, like the web UI. */
export async function findRawExpense(client: MilltimeClient, date: string, id: string): Promise<RawExpense> {
  const raw = (await fetchRawExpenses(client, { from: date, to: date })).find((r) => r.expenseid === id);
  if (!raw) throw new Error(`Expense ${id} not found on ${date}`);
  return raw;
}

export async function listExpenses(client: MilltimeClient, range: DateRange): Promise<Expense[]> {
  return (await fetchRawExpenses(client, range)).map(toExpense);
}
