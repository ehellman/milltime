import { addDays, isoWeekNumber, weekRange } from "../dates.ts";
import type { DateRange } from "../dates.ts";
import { UsageError } from "./errors.ts";

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_WEEK = /^(?:(\d{4})-)?w(\d{1,2})$/i;
const MONTH = /^(\d{4})-(\d{2})$/;

const WEEK_FORMATS = "YYYY-MM-DD, today, prev, next, 2026-W42 or w42";
const DATE_FORMATS = "YYYY-MM-DD, today or yesterday";

export const WEEK_HELP = `Arguments:
  week  YYYY-MM-DD (the week containing that day), today (default), prev, next, 2026-W42 or w42 (this year)`;

/** Returns the Monday of the selected week. `today` is "YYYY-MM-DD". */
export function parseWeekArg(arg: string | undefined, today: string): string {
  const thisMonday = weekRange(today).from;
  if (arg === undefined || arg === "today") return thisMonday;
  if (arg === "prev") return addDays(thisMonday, -7);
  if (arg === "next") return addDays(thisMonday, 7);
  if (DATE.test(arg) && isValidDate(arg)) return weekRange(arg).from;

  const isoWeek = ISO_WEEK.exec(arg);
  if (isoWeek) {
    const year = isoWeek[1] ? Number(isoWeek[1]) : Number(today.slice(0, 4));
    return mondayOfIsoWeek(year, Number(isoWeek[2]), arg);
  }
  throw new UsageError(`Invalid week "${arg}". Use ${WEEK_FORMATS}.`);
}

/** A single day: "YYYY-MM-DD", `today` or `yesterday`. */
export function parseDateArg(arg: string, today: string): string {
  if (arg === "today") return today;
  if (arg === "yesterday") return addDays(today, -1);
  if (DATE.test(arg) && isValidDate(arg)) return arg;
  throw new UsageError(`Invalid date "${arg}". Use ${DATE_FORMATS}.`);
}

/** Returns the first and last day of the selected month. `today` is "YYYY-MM-DD". */
export function parseMonthArg(arg: string | undefined, today: string): DateRange {
  const month = MONTH.exec(arg ?? today.slice(0, 7));
  const year = Number(month?.[1]);
  const monthNumber = Number(month?.[2]);
  if (!month || monthNumber < 1 || monthNumber > 12) {
    throw new UsageError(`Invalid month "${arg}". Use YYYY-MM.`);
  }
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { from: `${month[1]}-${month[2]}-01`, to: `${month[1]}-${month[2]}-${lastDay}` };
}

function mondayOfIsoWeek(year: number, week: number, arg: string): string {
  // 4 January is always in ISO week 1, and 28 December always in the year's last week.
  const weeksInYear = isoWeekNumber(`${year}-12-28`);
  if (week < 1 || week > weeksInYear) {
    throw new UsageError(`Invalid week "${arg}": ${year} has weeks 1–${weeksInYear}.`);
  }
  return addDays(weekRange(`${year}-01-04`).from, (week - 1) * 7);
}

/** A parsed option: strings, booleans, or every value of a repeatable option. */
export type OptionValue = string | boolean | string[] | undefined;

function isValidDate(date: string): boolean {
  const parsed = new Date(`${date}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(date);
}

/** The optional single positional argument of a command. */
export function optionalArg(positionals: string[], name: string): string | undefined {
  if (positionals.length > 1) throw new UsageError(`Expected at most one ${name}, got "${positionals.join(" ")}".`);
  return positionals[0];
}

/** Exactly the named positional arguments, e.g. ["date", "row-id"]. */
export function requiredArgs(positionals: string[], names: string[]): string[] {
  if (positionals.length !== names.length) {
    const expected = names.map((name) => `<${name}>`).join(" ");
    throw new UsageError(`Expected ${expected}, got "${positionals.join(" ")}".`);
  }
  return positionals;
}

export function requiredOption(value: OptionValue, name: string): string {
  if (typeof value !== "string" || value === "") throw new UsageError(`Missing --${name}.`);
  return value;
}

export function optionalString(value: OptionValue): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A number given as an option, e.g. --hours 7.5. Undefined when the option is absent. */
export function parseNumberOption(value: OptionValue, name: string): number | undefined {
  if (value === undefined) return undefined;
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(number)) throw new UsageError(`Invalid --${name} "${value}". Use a number, e.g. 7.5.`);
  return number;
}

export function parsePositiveOption(value: OptionValue, name: string): number | undefined {
  const number = parseNumberOption(value, name);
  if (number !== undefined && number <= 0) throw new UsageError(`--${name} must be more than 0.`);
  return number;
}
