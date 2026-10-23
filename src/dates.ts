export interface DateRange {
  from: string; // "YYYY-MM-DD"
  to: string;
}

function parseDate(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const result = parseDate(date);
  result.setUTCDate(result.getUTCDate() + days);
  return formatDate(result);
}

/** ISO-8601 week number for a "YYYY-MM-DD" date. */
export function isoWeekNumber(date: string): number {
  const day = parseDate(date);
  const thursday = new Date(day);
  thursday.setUTCDate(day.getUTCDate() + (4 - (day.getUTCDay() || 7)));
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  return Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

/** ISO week of today. The web UI sends this as `weekNumber`, regardless of the row's date. */
export function currentIsoWeek(): number {
  return isoWeekNumber(formatDate(new Date()));
}

/** Monday to Sunday of the ISO week containing the date. */
export function weekRange(date: string): DateRange {
  const weekday = parseDate(date).getUTCDay() || 7;
  const from = addDays(date, 1 - weekday);
  return { from, to: addDays(from, 6) };
}

/** Today in the local time zone, like the web UI. */
export function localToday(): string {
  return new Date().toLocaleDateString("sv-SE");
}

/** Local midnight of the date as a UTC ISO string, e.g. "2026-10-18T22:00:00.000Z" in Sweden. */
export function localMidnightIso(date: string): string {
  return new Date(`${date}T00:00:00`).toISOString();
}

/** Every date from `from` to `to`, inclusive. */
export function datesInRange(range: DateRange): string[] {
  const dates: string[] = [];
  for (let date = range.from; date <= range.to; date = addDays(date, 1)) dates.push(date);
  return dates;
}
