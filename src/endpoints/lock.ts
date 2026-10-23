import { z } from "zod";
import type { MilltimeClient } from "../client.ts";
import { isoWeekNumber, weekRange } from "../dates.ts";
import type { DateRange } from "../dates.ts";
import { dateRangeQuery } from "../filters.ts";
import { sendPlanned } from "../planned.ts";
import type { PlannedRequest } from "../planned.ts";
import { isLocked } from "./time-row.ts";

const RawLockCheckSchema = z.object({ lockMessage: z.string(), block: z.boolean() }).passthrough();

const RawTimeBucketSchema = z.object({ time: z.number(), label: z.string() }).passthrough();

const RawLockDataSchema = z
  .object({
    attestlevel: z.number(),
    scheduleTotal: z.number(),
    projtimeTotal: z.number(),
    flexTotal: z.number(),
    overtimeTotal: z.number(),
    specification: z
      .object({
        overtimes: z.record(RawTimeBucketSchema),
        traveltimes: z.record(RawTimeBucketSchema),
      })
      .passthrough(),
  })
  .passthrough();

export interface LockBlocker {
  message: string;
  /** false would be a warning that still allows locking (not yet observed). */
  blocking: boolean;
}

export interface TimeBucket {
  code: string; // e.g. "OverTime1", "TravelTime1"
  label: string;
  hours: number;
}

export interface LockStatus extends DateRange {
  week: number;
  locked: boolean;
  canLock: boolean;
  blockers: LockBlocker[];
  scheduledHours: number;
  reportedHours: number;
  flexHours: number;
  overtime: TimeBucket[];
  travelTime: TimeBucket[];
}

function toBuckets(record: Record<string, z.infer<typeof RawTimeBucketSchema>>): TimeBucket[] {
  return Object.entries(record).map(([code, bucket]) => ({ code, label: bucket.label, hours: bucket.time }));
}

/** What the UI shows before locking a week: whether it is locked, and what blocks locking. */
export async function getLockStatus(client: MilltimeClient, date: string): Promise<LockStatus> {
  const range = weekRange(date);
  const query = dateRangeQuery(range, ["period", "=", "week"]);
  const [checkResponse, dataResponse] = await Promise.all([
    client.request("GET", "/data/store/LockCheckData", { query }),
    client.request("GET", "/data/store/LockData", { query }),
  ]);

  const blockers = z
    .array(RawLockCheckSchema)
    .parse(checkResponse.rows ?? [])
    .map((raw) => ({ message: raw.lockMessage, blocking: raw.block }));
  const [data] = z.array(RawLockDataSchema).min(1).parse(dataResponse.rows ?? []);
  const locked = isLocked(data.attestlevel);

  return {
    ...range,
    week: isoWeekNumber(range.from),
    locked,
    canLock: !locked && blockers.every((blocker) => !blocker.blocking),
    blockers,
    scheduledHours: data.scheduleTotal,
    reportedHours: data.projtimeTotal,
    flexHours: data.flexTotal,
    overtime: toBuckets(data.specification.overtimes),
    travelTime: toBuckets(data.specification.traveltimes),
  };
}

/** Locking is irreversible for regular users: Milltime offers no unlock. Refuses locked and blocked weeks. */
export async function planLockWeek(client: MilltimeClient, date: string): Promise<PlannedRequest> {
  const status = await getLockStatus(client, date);
  const week = `week ${status.week} (${status.from} – ${status.to})`;
  if (status.locked) throw new Error(`${capitalize(week)} is already locked`);
  if (!status.canLock) {
    const reasons = status.blockers.filter((b) => b.blocking).map((b) => b.message);
    throw new Error(`Cannot lock ${week}: ${reasons.join(" ")}`);
  }

  const warnings = status.blockers.map((b) => ` Warning: ${b.message}`).join("");
  return {
    method: "POST",
    path: "/data/store/LockData",
    body: {
      fromDate: status.from,
      toDate: status.to,
      period: "week",
      usernote: "",
      check: false,
      OverTime1Comp: 0,
      OverTime2Comp: 0,
      TravelTime1Comp: 0,
      TravelTime2Comp: 0,
      PlusTimeComp: 0,
      FlexComp: 0,
    },
    summary: `Lock ${week}: ${status.reportedHours}h reported. This cannot be undone.${warnings}`,
  };
}

export async function lockWeek(client: MilltimeClient, date: string): Promise<LockStatus> {
  await sendPlanned(client, await planLockWeek(client, date));
  return getLockStatus(client, date);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
