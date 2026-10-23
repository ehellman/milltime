import { z } from "zod";
import type { MilltimeClient } from "../client.ts";
import type { DateRange } from "../dates.ts";
import { dateRangeQuery } from "../filters.ts";
import { isLocked } from "./time-row.ts";

export const ALLOWANCE_PATH = "/data/store/Allowance";

/** The home country (Sweden), which Milltime stores as "-1". Other countries are ISO alpha-3 codes, e.g. "NOR". */
export const DOMESTIC = "domestic";

export type Breakfast = "paid-myself" | "hotel" | "ticket" | "employer";
export type Meal = "paid-myself" | "deduction" | "ticket" | "employer";

export interface Meals {
  breakfast: Breakfast;
  lunch: Meal;
  dinner: Meal;
}

// ---------------------------------------------------------------------------
// Milltime encoding
// ---------------------------------------------------------------------------

const BREAKFAST_CODES: Record<Breakfast, number> = { "paid-myself": 0, hotel: 1, ticket: -1, employer: 2 };
const MEAL_CODES: Record<Meal, number> = { "paid-myself": 0, deduction: 1, ticket: -1, employer: 2 };

export const BREAKFAST_OPTIONS = Object.keys(BREAKFAST_CODES) as Breakfast[];
export const MEAL_OPTIONS = Object.keys(MEAL_CODES) as Meal[];

const NOT_SET = "-1";

export function encodeMeals(meals: Meals): { breakfastpaid: number; lunchpaid: number; dinnerpaid: number } {
  return {
    breakfastpaid: BREAKFAST_CODES[meals.breakfast],
    lunchpaid: MEAL_CODES[meals.lunch],
    dinnerpaid: MEAL_CODES[meals.dinner],
  };
}

function decodeCode<T extends string>(codes: Record<T, number>, code: number, field: string): T {
  const option = (Object.keys(codes) as T[]).find((key) => codes[key] === code);
  if (!option) throw new Error(`Unknown ${field} value ${code}`);
  return option;
}

export function encodeDayCountry(country: string): string {
  return country === DOMESTIC ? NOT_SET : country;
}

/** Private accommodation: "-1" none, "" domestic, else the country code. */
export function encodeNightCountry(country: string | null): string {
  if (country === null) return NOT_SET;
  return country === DOMESTIC ? "" : country;
}

function decodeNightCountry(code: string): string | null {
  if (code === NOT_SET) return null;
  return code === "" ? DOMESTIC : code;
}

/** The web UI only asks before/after 12 on the departure day and 19 on the return day. */
export const DEPARTURE = { beforeNoon: "11.00", afterNoon: "13.00" };
export const RETURN = { before7pm: "18.00", after7pm: "20.00" };

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

const RawProjectSchema = z
  .object({ projectid: z.string(), projectname: z.string(), projectnr: z.string(), customername: z.string() })
  .passthrough();

const RawAllowanceDaySchema = z
  .object({
    regday: z.string(),
    daycountrycode: z.string(),
    nightcountrycode: z.string(),
    destination: z.string(),
    breakfastpaid: z.number(),
    lunchpaid: z.number(),
    dinnerpaid: z.number(),
    arrtime: z.number().nullable(),
    deptime: z.number().nullable(),
    attestlevel: z.number().nullable(),
    project: RawProjectSchema,
  })
  .passthrough();

const RawAllowanceSchema = z
  .object({
    allowanceid: z.string(),
    purpose: z.string(),
    totalcompensation: z.number(),
    allowancedays: z.array(RawAllowanceDaySchema).min(1),
  })
  .passthrough();

export type RawAllowance = z.infer<typeof RawAllowanceSchema>;

export interface AllowanceDay {
  date: string;
  /** DOMESTIC or a country code. */
  country: string;
  /** Where the user stayed privately the night before this day: null for none, else DOMESTIC or a country code. */
  privateAccommodation: string | null;
  meals: Meals;
  destination: string;
  projectId: string;
  locked: boolean;
}

export interface Allowance {
  id: string;
  purpose: string;
  from: string;
  to: string;
  departedBeforeNoon: boolean;
  returnedAfter7pm: boolean;
  destination: string;
  project: { id: string; name: string; number: string; customer: string };
  /** Computed by Milltime. */
  totalCompensation: number;
  /** True when any day is locked. */
  locked: boolean;
  days: AllowanceDay[];
}

function toAllowanceDay(raw: RawAllowance["allowancedays"][number]): AllowanceDay {
  return {
    date: raw.regday,
    country: raw.daycountrycode === NOT_SET ? DOMESTIC : raw.daycountrycode,
    privateAccommodation: decodeNightCountry(raw.nightcountrycode),
    meals: {
      breakfast: decodeCode(BREAKFAST_CODES, raw.breakfastpaid, "breakfastpaid"),
      lunch: decodeCode(MEAL_CODES, raw.lunchpaid, "lunchpaid"),
      dinner: decodeCode(MEAL_CODES, raw.dinnerpaid, "dinnerpaid"),
    },
    destination: raw.destination,
    projectId: raw.project.projectid,
    locked: isLocked(raw.attestlevel),
  };
}

export function toAllowance(raw: RawAllowance): Allowance {
  const first = raw.allowancedays[0];
  const last = raw.allowancedays.at(-1)!;
  const days = raw.allowancedays.map(toAllowanceDay);
  return {
    id: raw.allowanceid,
    purpose: raw.purpose,
    from: first.regday,
    to: last.regday,
    departedBeforeNoon: (first.deptime ?? 0) < 12,
    returnedAfter7pm: (last.arrtime ?? 24) > 19,
    destination: first.destination,
    project: {
      id: first.project.projectid,
      name: first.project.projectname,
      number: first.project.projectnr,
      customer: first.project.customername,
    },
    totalCompensation: raw.totalcompensation,
    locked: days.some((day) => day.locked),
    days,
  };
}

/** Rows come back flat from GET and PUT, but nested one level deeper from POST. */
export function parseAllowanceRows(rows: unknown[] | undefined): RawAllowance[] {
  return z.array(RawAllowanceSchema).parse((rows ?? []).flat());
}

async function fetchRawAllowances(client: MilltimeClient, range: DateRange): Promise<RawAllowance[]> {
  const response = await client.request("GET", ALLOWANCE_PATH, { query: dateRangeQuery(range) });
  return parseAllowanceRows(response.rows);
}

/** Milltime returns every allowance overlapping the range, so listing any day of the trip finds it. */
export async function findRawAllowance(client: MilltimeClient, date: string, id: string): Promise<RawAllowance> {
  const raw = (await fetchRawAllowances(client, { from: date, to: date })).find((r) => r.allowanceid === id);
  if (!raw) throw new Error(`Allowance ${id} not found on ${date}`);
  return raw;
}

/** Allowances overlapping the range. */
export async function listAllowances(client: MilltimeClient, range: DateRange): Promise<Allowance[]> {
  return (await fetchRawAllowances(client, range)).map(toAllowance);
}
