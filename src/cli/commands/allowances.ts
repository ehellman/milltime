import type { MilltimeClient } from "../../client.ts";
import {
  createAllowance,
  deleteAllowance,
  planCreateAllowance,
  planDeleteAllowance,
  planUpdateAllowance,
  updateAllowance,
} from "../../endpoints/allowance-writes.ts";
import { BREAKFAST_OPTIONS, MEAL_OPTIONS, listAllowances } from "../../endpoints/allowances.ts";
import type { Allowance } from "../../endpoints/allowances.ts";
import { listAllowanceProjects, listCountries } from "../../endpoints/reference.ts";
import { parseAllowanceOptions, parseNewAllowance } from "../allowance-options.ts";
import { optionalArg, parseDateArg, parseMonthArg, requiredArgs } from "../args.ts";
import type { CliContext } from "../context.ts";
import { UsageError } from "../errors.ts";
import { dryRunOutput } from "../format/plan.ts";
import { formatTable } from "../format/table.ts";
import { withSession } from "../session.ts";
import type { Command, CommandGroup, CommandInput, CommandOutput } from "./registry.ts";

async function list({ positionals }: CommandInput, ctx: CliContext): Promise<CommandOutput> {
  const range = parseMonthArg(optionalArg(positionals, "month"), ctx.today());
  const all = await withSession(ctx, (client) => listAllowances(client, range));
  const text = all.length === 0 ? `No allowances in ${range.from.slice(0, 7)}.` : all.map(formatAllowance).join("\n\n");
  return { data: all, text };
}

function describeAllowance(allowance: Allowance): string {
  return `${allowance.from} – ${allowance.to} to ${allowance.destination} (${allowance.purpose})`;
}

function formatAllowance(allowance: Allowance): string {
  const departure = allowance.departedBeforeNoon ? "before 12" : "after 12";
  const arrival = allowance.returnedAfter7pm ? "after 19" : "before 19";
  const rows = allowance.days.map((day) => [
    day.date,
    day.country,
    day.privateAccommodation ?? "",
    day.meals.breakfast,
    day.meals.lunch,
    day.meals.dinner,
    day.locked ? "yes" : "",
  ]);
  return [
    `${describeAllowance(allowance)}, id ${allowance.id}`,
    `Project ${allowance.project.name}. Left ${departure}, back ${arrival}. Compensation ${allowance.totalCompensation.toFixed(2)}.`,
    formatTable(["Date", "Country", "Private accommodation", "Breakfast", "Lunch", "Dinner", "Locked"], rows),
  ].join("\n");
}

async function countries(_input: CommandInput, ctx: CliContext): Promise<CommandOutput> {
  const all = await withSession(ctx, listCountries);
  const rows = all.map((country) => [country.code, country.name, country.isDefault ? "domestic" : ""]);
  return { data: all, text: formatTable(["Code", "Country", ""], rows) };
}

async function projects(_input: CommandInput, ctx: CliContext): Promise<CommandOutput> {
  const all = await withSession(ctx, listAllowanceProjects);
  const rows = all.map((project) => [project.number, project.name, project.customer, project.id]);
  return { data: all, text: formatTable(["Number", "Project", "Customer", "Id"], rows) };
}

async function assertAllowanceProject(client: MilltimeClient, projectId: string | undefined): Promise<void> {
  if (projectId === undefined) return;
  if (!(await listAllowanceProjects(client)).some((project) => project.id === projectId)) {
    throw new UsageError(`No allowance project with id "${projectId}". Run "milltime allowances projects" to list them.`);
  }
}

async function add({ values }: CommandInput, ctx: CliContext): Promise<CommandOutput> {
  const allowance = parseNewAllowance(values, ctx.today());

  return withSession(ctx, async (client) => {
    await assertAllowanceProject(client, allowance.projectId);
    if (values["dry-run"]) return dryRunOutput(await planCreateAllowance(client, allowance));
    const created = await createAllowance(client, allowance);
    return { data: created, text: `Added allowance ${created.id}\n${formatAllowance(created)}` };
  });
}

async function edit({ positionals, values }: CommandInput, ctx: CliContext): Promise<CommandOutput> {
  const [dateArg, id] = requiredArgs(positionals, ["date", "id"]);
  const allowance = { id, from: parseDateArg(dateArg, ctx.today()) };
  const changes = parseAllowanceOptions(values, ctx.today());
  if (Object.keys(changes).length === 0) throw new UsageError('Nothing to change. See "milltime allowances edit --help".');

  return withSession(ctx, async (client) => {
    await assertAllowanceProject(client, changes.projectId);
    if (values["dry-run"]) return dryRunOutput(await planUpdateAllowance(client, allowance, changes));
    const saved = await updateAllowance(client, allowance, changes);
    return { data: saved, text: `Updated allowance ${saved.id}\n${formatAllowance(saved)}` };
  });
}

async function remove({ positionals, values }: CommandInput, ctx: CliContext): Promise<CommandOutput> {
  const [dateArg, id] = requiredArgs(positionals, ["date", "id"]);
  const allowance = { id, from: parseDateArg(dateArg, ctx.today()) };

  return withSession(ctx, async (client) => {
    if (values["dry-run"]) return dryRunOutput(await planDeleteAllowance(client, allowance));
    await deleteAllowance(client, allowance);
    return { data: { deleted: allowance }, text: `Deleted allowance ${id}` };
  });
}

const DRY_RUN_HELP = "  --dry-run                Show the request without sending it";
const ALLOWANCE_HELP = [
  "Arguments:",
  "  date  Any day of the trip: YYYY-MM-DD, today or yesterday",
  '  id    The allowance\'s id, from "milltime allowances list"',
].join("\n");

const TRIP_OPTIONS: Command["options"] = {
  from: { type: "string" },
  to: { type: "string" },
  departure: { type: "string" },
  return: { type: "string" },
  destination: { type: "string" },
  purpose: { type: "string" },
  project: { type: "string" },
  country: { type: "string" },
  breakfast: { type: "string" },
  lunch: { type: "string" },
  dinner: { type: "string" },
  "private-accommodation": { type: "string" },
  day: { type: "string", multiple: true },
  "dry-run": { type: "boolean" },
};

const TRIP_HELP = [
  "  --from                   Departure day",
  "  --to                     Return day",
  "  --departure              before-noon or after-noon",
  "  --return                 before-7pm or after-7pm",
  "  --destination            Where you went",
  "  --purpose                Why you went",
  '  --project                Project id, from "milltime allowances projects"',
  '  --country                Country code from "milltime allowances countries", or domestic',
  `  --breakfast              Every day: ${BREAKFAST_OPTIONS.join(", ")}`,
  `  --lunch, --dinner        Every day: ${MEAL_OPTIONS.join(", ")}`,
  "  --private-accommodation  yes or no: stayed privately every night",
  "  --day                    Exception for one day, repeatable, e.g.",
  "                           2026-10-20:accommodation=yes,lunch=employer",
  "                           Keys: country, accommodation, breakfast, lunch, dinner",
  DRY_RUN_HELP,
].join("\n");

export const allowances: CommandGroup = {
  summary: "Allowances (traktamente) for business trips.",
  commands: {
    list: {
      summary: "List your allowances overlapping a month, day by day",
      usage: "[month]",
      details: "Arguments:\n  month  YYYY-MM (default: this month)",
      run: list,
    },
    countries: { summary: "List countries for allowances", run: countries },
    projects: { summary: "List projects you can put allowances on", run: projects },
    add: {
      summary: "Add an allowance; Milltime computes the compensation",
      usage:
        "--from <date> --to <date> --departure <when> --return <when> --destination <text> --purpose <text> --project <id> --breakfast <x> --lunch <x> --dinner <x> --private-accommodation <yes|no> [--country <code>] [--day <date:key=value,…>]…",
      details: ["Options (all required except --country, default domestic, and --day):", TRIP_HELP].join("\n"),
      options: TRIP_OPTIONS,
      run: add,
    },
    edit: {
      summary: "Change an allowance; trip-wide options apply to every day",
      usage: "<date> <id> [the options of add]",
      details: [
        ALLOWANCE_HELP,
        "Options (all optional; days added by --from/--to copy the nearest day):",
        TRIP_HELP,
      ].join("\n"),
      options: TRIP_OPTIONS,
      run: edit,
    },
    delete: {
      summary: "Delete an allowance",
      usage: "<date> <id>",
      details: [ALLOWANCE_HELP, "Options:", DRY_RUN_HELP].join("\n"),
      options: { "dry-run": { type: "boolean" } },
      run: remove,
    },
  },
};
