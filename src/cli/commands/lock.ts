import { getLockStatus, lockWeek, planLockWeek } from "../../endpoints/lock.ts";
import type { LockStatus, TimeBucket } from "../../endpoints/lock.ts";
import { optionalArg, parseWeekArg, requiredArgs, WEEK_HELP } from "../args.ts";
import type { CliContext } from "../context.ts";
import { formatHours } from "../format/hours.ts";
import { dryRunOutput } from "../format/plan.ts";
import { withSession } from "../session.ts";
import type { CommandGroup, CommandInput, CommandOutput } from "./registry.ts";

async function status({ positionals }: CommandInput, ctx: CliContext): Promise<CommandOutput> {
  const monday = parseWeekArg(optionalArg(positionals, "week"), ctx.today());
  const lockStatus = await withSession(ctx, (client) => getLockStatus(client, monday));
  return { data: lockStatus, text: formatLockStatus(lockStatus) };
}

function formatLockStatus(status: LockStatus): string {
  return [
    `Week ${status.week}: ${status.from} – ${status.to}`,
    `Status: ${statusWord(status)}`,
    ...status.blockers.map((blocker) => `  ${blocker.blocking ? "Blocked" : "Warning"}: ${blocker.message}`),
    `Reported ${formatHours(status.reportedHours)} of ${formatHours(status.scheduledHours)} · flex ${formatHours(status.flexHours)}`,
    ...bucketLine("Overtime", status.overtime),
    ...bucketLine("Travel time", status.travelTime),
  ].join("\n");
}

function statusWord(status: LockStatus): string {
  if (status.locked) return "locked";
  return status.canLock ? "can be locked" : "cannot be locked yet";
}

/** Lists the non-zero buckets, or nothing. */
function bucketLine(title: string, buckets: TimeBucket[]): string[] {
  const used = buckets.filter((bucket) => bucket.hours !== 0);
  if (used.length === 0) return [];
  return [`${title}: ${used.map((bucket) => `${bucket.label} ${formatHours(bucket.hours)}`).join(", ")}`];
}

/** Locking cannot be undone, so the week must be named and --yes given; without it, only the plan is shown. */
async function week({ positionals, values }: CommandInput, ctx: CliContext): Promise<CommandOutput> {
  const [weekArg] = requiredArgs(positionals, ["week"]);
  const monday = parseWeekArg(weekArg, ctx.today());

  return withSession(ctx, async (client) => {
    if (!values.yes || values["dry-run"]) {
      const preview = dryRunOutput(await planLockWeek(client, monday));
      return { ...preview, text: `${preview.text}\nRun again with --yes to lock the week.` };
    }
    const locked = await lockWeek(client, monday);
    return { data: locked, text: formatLockStatus(locked) };
  });
}

export const lock: CommandGroup = {
  summary: "Week locking.",
  commands: {
    status: {
      summary: "Show whether a week is locked or what blocks locking it",
      usage: "[week]",
      details: WEEK_HELP,
      run: status,
    },
    week: {
      summary: "Lock a week. Cannot be undone",
      usage: "<week> --yes",
      details: [
        WEEK_HELP.replace("today (default)", "today"),
        "Options:",
        "  --yes      Lock the week. Without it, shows what would be sent",
        "  --dry-run  Show the request without sending it, even with --yes",
      ].join("\n"),
      options: { yes: { type: "boolean" }, "dry-run": { type: "boolean" } },
      run: week,
    },
  },
};
