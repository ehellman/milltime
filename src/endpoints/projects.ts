import { z } from "zod";
import type { MilltimeClient } from "../client.ts";

const RawActivitySchema = z
  .object({
    common: z
      .object({
        projectid: z.string(),
        projectname: z.string(),
        activity: z.string(),
        activityname: z.string(),
        planningtaskid: z.string().nullable(),
        absencetype: z.string().nullable(),
        requirenote: z.boolean().nullable(),
        timedistributiontype: z.string().nullable(),
      })
      .passthrough(),
  })
  .passthrough();

const RawProjectSchema = z
  .object({
    projectid: z.string(),
    projectname: z.string(),
    projectnr: z.string(),
    customernames: z.string(),
    activities: z.array(RawActivitySchema),
  })
  .passthrough();

// Work activities come back without a type; the web UI reports them as NORMALTIME.
const DEFAULT_TIME_TYPE = "NORMALTIME";

export interface Activity {
  id: string;
  name: string;
  project: { id: string; name: string };
  taskId: string | null;
  /** e.g. "NORMALTIME", "TRAVELTIME1". */
  timeType: string;
  /** Set for absence activities, e.g. "VACATION", "SICK", "FLEX". */
  absenceType: string | null;
  requiresNote: boolean;
}

/**
 * Identifies an activity for reporting: its task id, or the activity id when it has no task.
 * Activity ids alone are not unique; one activity can be planned as several tasks.
 */
export function activityKey(activity: Activity): string {
  return activity.taskId ?? activity.id;
}

export interface Project {
  id: string;
  name: string;
  number: string;
  customer: string;
  activities: Activity[];
}

function toActivity(raw: z.infer<typeof RawActivitySchema>): Activity {
  const c = raw.common;
  return {
    id: c.activity,
    name: c.activityname,
    project: { id: c.projectid, name: c.projectname },
    taskId: c.planningtaskid,
    timeType: c.timedistributiontype ?? DEFAULT_TIME_TYPE,
    absenceType: c.absencetype,
    requiresNote: c.requirenote ?? false,
  };
}

/** Projects and activities the user can report time on (the "favorites" list in the UI). */
export async function listProjects(client: MilltimeClient): Promise<Project[]> {
  const response = await client.request("GET", "/data/store/ProjectFavorite");
  return z
    .array(RawProjectSchema)
    .parse(response.rows ?? [])
    .map((raw) => ({
      id: raw.projectid,
      name: raw.projectname,
      number: raw.projectnr,
      customer: raw.customernames,
      activities: raw.activities.map(toActivity),
    }));
}
