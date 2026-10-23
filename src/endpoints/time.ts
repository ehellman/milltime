import type { MilltimeClient } from "../client.ts";
import { currentIsoWeek } from "../dates.ts";
import { filterQuery } from "../filters.ts";
import { toHours } from "../hours.ts";
import { sendPlanned } from "../planned.ts";
import type { PlannedRequest } from "../planned.ts";
import { findRawTimeRow, getCalendar } from "./calendar.ts";
import type { Activity } from "./projects.ts";
import { RawTimeRowSchema, toTimeRow } from "./time-row.ts";
import type { RawTimeRow, TimeRow } from "./time-row.ts";

const STORE_PATH = "/data/store/ProjectRegistrationReact";

export interface NewTimeRow {
  activity: Activity;
  date: string; // "YYYY-MM-DD"
  hours: number;
  note?: string;
}

export interface TimeRowChanges {
  hours?: number;
  note?: string;
}

// ---------------------------------------------------------------------------
// Payload builders — mirror what the web UI sends (see tests/fixtures/time-*.json)
// ---------------------------------------------------------------------------

function formatHours(hours: number): string {
  return hours.toFixed(2);
}

/** Absence (vacation, sick leave, flex, …) is a normal row on an absence activity, with `absencetype` set. */
export function buildCreatePayload(row: NewTimeRow, userId: string): Record<string, unknown> {
  const { activity } = row;
  return {
    absencetype: activity.absenceType,
    attestlevel: 0,
    favoritetype: 0,
    phaseid: "Default",
    phasename: "",
    projectnr: "",
    planningtaskid: activity.taskId,
    planningtype: 0,
    regday: row.date,
    reportnr: 0,
    selfinvoicenr: 0,
    requirenote: false,
    ticket: {},
    userid: userId,
    variationid: "",
    weekNumber: currentIsoWeek(),
    timedistributiontype: activity.timeType,
    projtime: formatHours(row.hours),
    inputtime: String(row.hours),
    ...(row.note !== undefined && { usernote: row.note }),
    internalnote: "",
    projectid: activity.project.id,
    projectname: activity.project.name,
    activity: activity.id,
    activityname: activity.name,
  };
}

export function buildUpdatePayload(raw: RawTimeRow, changes: TimeRowChanges): Record<string, unknown> {
  const hours = formatHours(changes.hours ?? toHours(raw.projtimehh, raw.projtimemm));
  return {
    absencetype: raw.absencetype,
    billtimemm: raw.billtimemm,
    attestlevel: raw.attestlevel ?? 0,
    favoritetype: raw.favoritetype ?? 0,
    phaseid: raw.phaseid,
    phasename: raw.phasename,
    projectnr: raw.projectnr,
    planningtaskid: raw.planningtaskid,
    planningtaskname: raw.planningtaskname,
    planningtype: raw.planningtype,
    projectregistrationid: raw.projectregistrationid,
    regday: raw.regday,
    reportnr: raw.reportnr ?? 0,
    selfinvoicenr: raw.selfinvoicenr ?? 0,
    requirenote: raw.requirenote ?? false,
    ticket: raw.ticket,
    userid: raw.userid,
    variationid: raw.variationid ?? "",
    weekNumber: currentIsoWeek(),
    projplandescription: raw.projplandescription,
    billtimehh: raw.billtimehh,
    timedistributiontype: raw.timedistributiontype,
    projtime: hours,
    usernote: changes.note ?? raw.usernote,
    inputtime: hours,
    internalnote: raw.internalnote ?? "",
    projectid: raw.projectid,
    projectname: raw.projectname,
    activity: raw.activity,
    activityname: raw.activityname,
  };
}

function parseSavedRow(rows: unknown[] | undefined): TimeRow {
  if (!rows?.length) throw new Error("API returned no rows");
  return toTimeRow(RawTimeRowSchema.parse(rows[0]));
}

function describeRow(hours: number, activityName: string, projectName: string, date: string): string {
  return `${hours}h ${activityName} (${projectName}) on ${date}`;
}

function describeNote(note: string | undefined): string {
  return note ? `, note "${note}"` : "";
}

async function readUnlockedRow(client: MilltimeClient, row: Pick<TimeRow, "id" | "date">): Promise<RawTimeRow> {
  const raw = await findRawTimeRow(client, row.date, row.id);
  if (toTimeRow(raw).locked) throw new Error(`Time row ${row.id} on ${row.date} is locked`);
  return raw;
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/** Refuses locked days up front; other refusals (e.g. a future week before earlier weeks are locked) come from Milltime. */
export async function planReportTime(client: MilltimeClient, row: NewTimeRow): Promise<PlannedRequest> {
  if (row.activity.requiresNote && !row.note) throw new Error(`Activity ${row.activity.name} requires a note`);
  const [day] = await getCalendar(client, { from: row.date, to: row.date });
  if (day?.locked) throw new Error(`Day ${row.date} is locked`);

  return {
    method: "POST",
    path: STORE_PATH,
    body: buildCreatePayload(row, await client.getUserId()),
    summary: `Report ${describeRow(row.hours, row.activity.name, row.activity.project.name, row.date)}${describeNote(row.note)}`,
  };
}

export async function reportTime(client: MilltimeClient, row: NewTimeRow): Promise<TimeRow> {
  const response = await sendPlanned(client, await planReportTime(client, row));
  return parseSavedRow(response.rows);
}

/** Re-reads the row from Milltime and saves it with the changes applied, like the web UI. */
export async function planUpdateTimeRow(
  client: MilltimeClient,
  row: Pick<TimeRow, "id" | "date">,
  changes: TimeRowChanges,
): Promise<PlannedRequest> {
  const raw = await readUnlockedRow(client, row);
  const current = toTimeRow(raw);
  const described = describeRow(current.hours, current.activity.name, current.project.name, current.date);
  const edits = [
    changes.hours !== undefined && `hours ${current.hours}h → ${changes.hours}h`,
    changes.note !== undefined && `note "${changes.note}"`,
  ].filter(Boolean);
  return {
    method: "PUT",
    path: STORE_PATH,
    query: filterQuery(["ProjectRegistrationId", "=", row.id]),
    body: buildUpdatePayload(raw, changes),
    summary: `Update ${described}: ${edits.join(", ") || "no changes"}`,
  };
}

export async function updateTimeRow(
  client: MilltimeClient,
  row: Pick<TimeRow, "id" | "date">,
  changes: TimeRowChanges,
): Promise<TimeRow> {
  const response = await sendPlanned(client, await planUpdateTimeRow(client, row, changes));
  return parseSavedRow(response.rows);
}

/** Deletes a time row, like setting it to 0 hours in the web UI. Re-reads it first to refuse locked rows. */
export async function planDeleteTimeRow(
  client: MilltimeClient,
  row: Pick<TimeRow, "id" | "date">,
): Promise<PlannedRequest> {
  const current = toTimeRow(await readUnlockedRow(client, row));
  return {
    method: "DELETE",
    path: STORE_PATH,
    query: filterQuery(["ProjectRegistrationId", "=", row.id], ["TimeDistributionType", "=", current.timeType]),
    summary: `Delete ${describeRow(current.hours, current.activity.name, current.project.name, current.date)}`,
  };
}

export async function deleteTimeRow(client: MilltimeClient, row: Pick<TimeRow, "id" | "date">): Promise<void> {
  await sendPlanned(client, await planDeleteTimeRow(client, row));
}
