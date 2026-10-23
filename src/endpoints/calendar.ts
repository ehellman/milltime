import { z } from "zod";
import type { MilltimeClient } from "../client.ts";
import { isoWeekNumber, weekRange } from "../dates.ts";
import type { DateRange } from "../dates.ts";
import { dateRangeQuery } from "../filters.ts";
import { toHours } from "../hours.ts";
import { RawTimeRowSchema, isLocked, toTimeRow } from "./time-row.ts";
import type { RawTimeRow, TimeRow } from "./time-row.ts";

// ---------------------------------------------------------------------------
// Raw schemas
// ---------------------------------------------------------------------------

const RawDaySchema = z
  .object({
    regday: z.string(),
    stdtime: z.number().nullable(),
    holiday: z.boolean(),
    attestlevel: z.number(),
    projectregistrations: z.array(RawTimeRowSchema),
    flexdiff: z.object({ hh: z.number().nullable(), mm: z.number().nullable() }).nullable().optional(),
  })
  .passthrough();

const RawMonthSchema = z
  .object({
    weeks: z.array(z.object({ weeknr: z.number(), days: z.array(RawDaySchema) }).passthrough()),
  })
  .passthrough();

const RawTimeInfoSchema = z
  .object({
    ScheduledPeriodTime: z.number(),
    WorkedPeriodTime: z.number(),
    AbsencePeriodTime: z.number(),
    PeriodTimeLeft: z.number(),
    FlexTimeCurrent: z.number(),
  })
  .passthrough();

type RawDay = z.infer<typeof RawDaySchema>;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface CalendarDay {
  date: string;
  holiday: boolean;
  /** null on days outside the user's schedule (e.g. future weekends). */
  scheduledHours: number | null;
  reportedHours: number;
  flexHours: number | null;
  locked: boolean;
  rows: TimeRow[];
}

export interface WeekSummary extends DateRange {
  week: number;
  locked: boolean;
  scheduledHours: number;
  workedHours: number;
  absenceHours: number;
  remainingHours: number;
  /** Accumulated flex balance, as shown in the Milltime UI. */
  flexBalanceHours: number;
  days: CalendarDay[];
}

// ---------------------------------------------------------------------------
// Raw access (also used by time.ts to re-read rows before updating them)
// ---------------------------------------------------------------------------

async function fetchRawDays(client: MilltimeClient, range: DateRange): Promise<RawDay[]> {
  const response = await client.request("GET", "/data/store/UserCalendar", { query: dateRangeQuery(range) });
  const months = z.array(RawMonthSchema).parse(response.rows ?? []);
  return months
    .flatMap((month) => month.weeks.flatMap((week) => week.days))
    .filter((day) => day.regday >= range.from && day.regday <= range.to);
}

export async function findRawTimeRow(client: MilltimeClient, date: string, id: string): Promise<RawTimeRow> {
  const days = await fetchRawDays(client, { from: date, to: date });
  const row = days.flatMap((day) => day.projectregistrations).find((r) => r.projectregistrationid === id);
  if (!row) throw new Error(`Time row ${id} not found on ${date}`);
  return row;
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

function toCalendarDay(day: RawDay): CalendarDay {
  const rows = day.projectregistrations.map(toTimeRow);
  return {
    date: day.regday,
    holiday: day.holiday,
    scheduledHours: day.stdtime,
    reportedHours: rows.reduce((sum, row) => sum + row.hours, 0),
    flexHours: day.flexdiff?.hh == null ? null : toHours(day.flexdiff.hh, day.flexdiff.mm),
    locked: isLocked(day.attestlevel),
    rows,
  };
}

export async function getCalendar(client: MilltimeClient, range: DateRange): Promise<CalendarDay[]> {
  const days = await fetchRawDays(client, range);
  return days.map(toCalendarDay);
}

export async function getWeekSummary(client: MilltimeClient, date: string): Promise<WeekSummary> {
  const range = weekRange(date);
  const [days, timeInfoResponse] = await Promise.all([
    getCalendar(client, range),
    client.request("GET", "/data/store/TimeInfo", { query: dateRangeQuery(range) }),
  ]);
  const [timeInfo] = z.array(RawTimeInfoSchema).min(1).parse(timeInfoResponse.rows ?? []);

  return {
    ...range,
    week: isoWeekNumber(range.from),
    locked: days.length > 0 && days.every((day) => day.locked),
    scheduledHours: timeInfo.ScheduledPeriodTime,
    workedHours: timeInfo.WorkedPeriodTime,
    absenceHours: timeInfo.AbsencePeriodTime,
    remainingHours: timeInfo.PeriodTimeLeft,
    flexBalanceHours: timeInfo.FlexTimeCurrent,
    days,
  };
}
