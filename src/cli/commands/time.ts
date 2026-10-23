import { getWeekSummary } from "../../endpoints/calendar.ts";
import type { CalendarDay, WeekSummary } from "../../endpoints/calendar.ts";
import { activityKey, listProjects } from "../../endpoints/projects.ts";
import type { Activity, Project } from "../../endpoints/projects.ts";
import type { TimeRow } from "../../endpoints/time-row.ts";
import {
  deleteTimeRow,
  planDeleteTimeRow,
  planReportTime,
  planUpdateTimeRow,
  reportTime,
  updateTimeRow,
} from "../../endpoints/time.ts";
import {
  optionalArg,
  optionalString,
  parseDateArg,
  parsePositiveOption,
  parseWeekArg,
  requiredArgs,
  requiredOption,
  WEEK_HELP,
} from "../args.ts";
import { UsageError } from "../errors.ts";
import type { CliContext } from "../context.ts";
import { weekdayName } from "../format/dates.ts";
import { formatHours } from "../format/hours.ts";
import { dryRunOutput } from "../format/plan.ts";
import { formatColumns, formatTable } from "../format/table.ts";
import { withSession } from "../session.ts";
import type { CommandGroup, CommandInput, CommandOutput } from "./registry.ts";

async function week({ positionals }: CommandInput, ctx: CliContext): Promise<CommandOutput> {
  const monday = parseWeekArg(optionalArg(positionals, "week"), ctx.today());
  const summary = await withSession(ctx, (client) => getWeekSummary(client, monday));
  return { data: summary, text: formatWeek(summary) };
}

function formatWeek(summary: WeekSummary): string {
  const header = `Week ${summary.week}: ${summary.from} – ${summary.to}${summary.locked ? " (locked)" : ""}`;
  const lines = summary.days.flatMap((day) => [dayLine(day, summary.locked), ...day.rows.map(rowLine)]);
  const footer = [
    `Worked ${formatHours(summary.workedHours)} of ${formatHours(summary.scheduledHours)}`,
    `absence ${formatHours(summary.absenceHours)}`,
    `remaining ${formatHours(summary.remainingHours)}`,
    `flex balance ${formatHours(summary.flexBalanceHours)}`,
  ].join(" · ");
  return [header, formatColumns(lines, { align: ["left", "left", "right"] }), footer].join("\n");
}

function dayLine(day: CalendarDay, weekLocked: boolean): string[] {
  const markers = [day.holiday && "holiday", day.locked && !weekLocked && "locked"].filter(Boolean).join(", ");
  const hours = `${formatHours(day.reportedHours)} / ${formatHours(day.scheduledHours)}`;
  const flex = day.flexHours ? `flex ${day.flexHours > 0 ? "+" : ""}${formatHours(day.flexHours)}` : "";
  return [`${weekdayName(day.date)} ${day.date}`, "", hours, "", [flex, markers].filter(Boolean).join(", ")];
}

function rowLine(row: CalendarDay["rows"][number]): string[] {
  const task = row.task?.name && row.task.name !== row.activity.name ? row.task.name : null;
  const activity = task ? `${row.activity.name} / ${task}` : row.activity.name;
  const notes = [row.note, row.internalNote && `internal: ${row.internalNote}`].filter(Boolean).join(" · ");
  return [`  ${row.project.name}`, activity, formatHours(row.hours), row.id, notes];
}

async function projects({ values }: CommandInput, ctx: CliContext): Promise<CommandOutput> {
  const all = await withSession(ctx, listProjects);
  const shown = values.all ? all : withoutAbsence(all);
  const rows = shown.flatMap((project) =>
    project.activities.map((activity) => [
      project.name,
      project.customer,
      activity.name,
      activity.timeType,
      activity.requiresNote ? "yes" : "",
      activityKey(activity),
    ]),
  );
  const headers = ["Project", "Customer", "Activity", "Time type", "Requires note", "Id"];
  return { data: shown, text: formatTable(headers, rows) };
}

/** Drops absence activities (vacation, sick leave, flex), and projects left without activities. */
function withoutAbsence(projects: Project[]): Project[] {
  return projects
    .map((project) => ({ ...project, activities: project.activities.filter((a) => a.absenceType === null) }))
    .filter((project) => project.activities.length > 0);
}

const DRY_RUN = { "dry-run": { type: "boolean" } } as const;
const DRY_RUN_HELP = "  --dry-run   Show the request without sending it";
const DATE_HELP = "  date    YYYY-MM-DD, today or yesterday";
const ROW_HELP = `${DATE_HELP}\n  row-id  The row's id, from "milltime time week"`;

function describeRow(row: TimeRow): string {
  return `${formatHours(row.hours)} ${row.activity.name} (${row.project.name}) on ${row.date}`;
}

function findActivity(projects: Project[], key: string): Activity {
  const matches = projects.flatMap((project) => project.activities).filter((a) => activityKey(a) === key);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new UsageError(`No activity with id "${key}". Run "milltime time projects --all" to list them.`);
  }
  const names = matches.map((a) => `${a.name} (${a.project.name})`).join(", ");
  throw new UsageError(`Activity id "${key}" matches several activities: ${names}.`);
}

async function add({ positionals, values }: CommandInput, ctx: CliContext): Promise<CommandOutput> {
  const [dateArg] = requiredArgs(positionals, ["date"]);
  const date = parseDateArg(dateArg, ctx.today());
  const key = requiredOption(values.activity, "activity");
  const hours = parsePositiveOption(requiredOption(values.hours, "hours"), "hours")!;
  const note = optionalString(values.note);

  return withSession(ctx, async (client) => {
    const row = { activity: findActivity(await listProjects(client), key), date, hours, note };
    if (values["dry-run"]) return dryRunOutput(await planReportTime(client, row));
    const saved = await reportTime(client, row);
    return { data: saved, text: `Reported ${describeRow(saved)} (row ${saved.id})` };
  });
}

async function edit({ positionals, values }: CommandInput, ctx: CliContext): Promise<CommandOutput> {
  const [dateArg, id] = requiredArgs(positionals, ["date", "row-id"]);
  const row = { id, date: parseDateArg(dateArg, ctx.today()) };
  const changes = { hours: parsePositiveOption(values.hours, "hours"), note: optionalString(values.note) };
  if (changes.hours === undefined && changes.note === undefined) {
    throw new UsageError('Nothing to change: give --hours or --note. To remove a row, use "milltime time delete".');
  }

  return withSession(ctx, async (client) => {
    if (values["dry-run"]) return dryRunOutput(await planUpdateTimeRow(client, row, changes));
    const saved = await updateTimeRow(client, row, changes);
    return { data: saved, text: `Updated row ${saved.id}: ${describeRow(saved)}` };
  });
}

async function remove({ positionals, values }: CommandInput, ctx: CliContext): Promise<CommandOutput> {
  const [dateArg, id] = requiredArgs(positionals, ["date", "row-id"]);
  const row = { id, date: parseDateArg(dateArg, ctx.today()) };

  return withSession(ctx, async (client) => {
    if (values["dry-run"]) return dryRunOutput(await planDeleteTimeRow(client, row));
    await deleteTimeRow(client, row);
    return { data: { deleted: row }, text: `Deleted row ${row.id} on ${row.date}` };
  });
}

export const time: CommandGroup = {
  summary: "Reported time and the projects you can report on.",
  commands: {
    week: {
      summary: "Show a week's reported time per day, with totals and flex balance",
      usage: "[week]",
      details: WEEK_HELP,
      run: week,
    },
    projects: {
      summary: "List your projects and activities",
      details: "Options:\n  --all  Include absence activities (vacation, sick leave, flex)",
      options: { all: { type: "boolean" } },
      run: projects,
    },
    add: {
      summary: "Report time on an activity",
      usage: "<date> --activity <id> --hours <h> [--note <text>]",
      details: [
        "Arguments:",
        DATE_HELP,
        "Options:",
        '  --activity  Activity id, from "milltime time projects --all"',
        "  --hours     Hours, e.g. 7.5",
        "  --note      Note on the row (required by some activities)",
        DRY_RUN_HELP,
      ].join("\n"),
      options: { activity: { type: "string" }, hours: { type: "string" }, note: { type: "string" }, ...DRY_RUN },
      run: add,
    },
    edit: {
      summary: "Change the hours or note of a reported row",
      usage: "<date> <row-id> [--hours <h>] [--note <text>]",
      details: ["Arguments:", ROW_HELP, "Options:", "  --hours     New hours", "  --note      New note", DRY_RUN_HELP].join("\n"),
      options: { hours: { type: "string" }, note: { type: "string" }, ...DRY_RUN },
      run: edit,
    },
    delete: {
      summary: "Delete a reported row",
      usage: "<date> <row-id>",
      details: ["Arguments:", ROW_HELP, "Options:", DRY_RUN_HELP].join("\n"),
      options: { ...DRY_RUN },
      run: remove,
    },
  },
};
