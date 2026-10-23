import { parseMonthArg } from "../cli/args.ts";
import type { DateRange } from "../dates.ts";

/** The given days, with this month filling in whichever end is missing. */
export function rangeOrThisMonth(input: { from?: string; to?: string }, today: string): DateRange {
  const month = parseMonthArg(undefined, today);
  return { from: input.from ?? month.from, to: input.to ?? month.to };
}
