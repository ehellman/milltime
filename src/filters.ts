import type { DateRange } from "./dates.ts";

type Clause = [field: string, operator: "=", value: string];

/** Builds the `filter` query parameter the data stores expect. */
export function filterQuery(...clauses: Clause[]): { filter: string } {
  return { filter: JSON.stringify(clauses) };
}

export function dateRangeQuery(range: DateRange, ...extra: Clause[]): { filter: string } {
  return filterQuery(["fromDate", "=", range.from], ["toDate", "=", range.to], ...extra);
}
