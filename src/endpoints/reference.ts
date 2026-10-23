import { z } from "zod";
import type { MilltimeClient } from "../client.ts";
import { filterQuery } from "../filters.ts";

const RawExpenseTypeSchema = z
  .object({
    ExpenseTypeId: z.string(),
    ExpenseTypeName: z.string(),
    NoVAT: z.boolean(),
    Disabled: z.number(),
    RequireNote: z.boolean().optional(),
    Representation: z.number().optional(),
  })
  .passthrough();

const RawCurrencySchema = z
  .object({
    CurrencyCode: z.string(),
    Currency: z.string().optional(),
    XRate: z.number(),
    Disabled: z.boolean(),
    Base: z.boolean().optional(),
  })
  .passthrough();

const RawCountrySchema = z
  .object({
    CountryCode: z.string(),
    Country: z.string(),
    IsDefault: z.boolean(),
    Disabled: z.boolean(),
  })
  .passthrough();

const RawMemberProjectSchema = z
  .object({
    ProjectId: z.string(),
    ProjectName: z.string(),
    ProjectNr: z.string(),
    CustomerNames: z.string(),
  })
  .passthrough();

export interface ExpenseType {
  id: string;
  name: string;
  noVat: boolean;
  requiresNote: boolean;
  /** Representation types need participants and a reason, which this library does not send. */
  representation: boolean;
}

export interface Currency {
  code: string;
  name: string;
  /** Exchange rate to the home currency. */
  rate: number;
  /** The currency expenses are converted into. */
  isHomeCurrency: boolean;
}

export interface Country {
  /** ISO 3166 alpha-3, e.g. "NOR". */
  code: string;
  name: string;
  /** The home country, which allowances call "domestic". */
  isDefault: boolean;
}

export interface MemberProject {
  id: string;
  name: string;
  number: string;
  customer: string;
}

/** Enabled expense types. */
export async function listExpenseTypes(client: MilltimeClient): Promise<ExpenseType[]> {
  const response = await client.request("GET", "/data/store/ExpenseTypes");
  return z
    .array(RawExpenseTypeSchema)
    .parse(response.rows ?? [])
    .filter((raw) => raw.Disabled === 0)
    .map((raw) => ({
      id: raw.ExpenseTypeId,
      name: raw.ExpenseTypeName,
      noVat: raw.NoVAT,
      requiresNote: raw.RequireNote ?? false,
      representation: (raw.Representation ?? 0) !== 0,
    }));
}

/** Enabled currencies with current exchange rates. */
export async function listCurrencies(client: MilltimeClient): Promise<Currency[]> {
  const response = await client.request("GET", "/data/store/Currency");
  return z
    .array(RawCurrencySchema)
    .parse(response.rows ?? [])
    .filter((raw) => !raw.Disabled)
    .map((raw) => ({
      code: raw.CurrencyCode,
      name: raw.Currency ?? raw.CurrencyCode,
      rate: raw.XRate,
      isHomeCurrency: raw.Base ?? false,
    }));
}

/** Enabled countries for allowances. */
export async function listCountries(client: MilltimeClient): Promise<Country[]> {
  const response = await client.request("GET", "/data/store/Country", {
    query: filterQuery(["Disabled", "=", "0"]),
  });
  return z
    .array(RawCountrySchema)
    .parse(response.rows ?? [])
    .filter((raw) => !raw.Disabled)
    .map((raw) => ({ code: raw.CountryCode, name: raw.Country, isDefault: raw.IsDefault }));
}

async function searchMemberProjects(client: MilltimeClient, view: "Expense" | "Allowance"): Promise<MemberProject[]> {
  const json = await client.requestInternal("GET", "/project/search", { query: { view, memberOnly: "true" } });
  return z
    .array(RawMemberProjectSchema)
    .parse(json)
    .map((raw) => ({ id: raw.ProjectId, name: raw.ProjectName, number: raw.ProjectNr, customer: raw.CustomerNames }));
}

/** Projects the user may put expenses on. Differs from the time-reporting project list. */
export function listExpenseProjects(client: MilltimeClient): Promise<MemberProject[]> {
  return searchMemberProjects(client, "Expense");
}

/** Projects the user may put allowances on. */
export function listAllowanceProjects(client: MilltimeClient): Promise<MemberProject[]> {
  return searchMemberProjects(client, "Allowance");
}
