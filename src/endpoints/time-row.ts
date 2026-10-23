import { z } from "zod";
import { toHours } from "../hours.ts";

const AttendenceLogSchema = z.object({
  clockstarthh: z.number().nullable(),
  clockstartmm: z.number().nullable(),
  clockendhh: z.number().nullable(),
  clockendmm: z.number().nullable(),
  lunchhh: z.number().nullable(),
  lunchmm: z.number().nullable(),
  attendencelogid: z.string().nullable(),
  regday: z.string().nullable(),
  userid: z.string().nullable(),
});

const TicketSchema = z.object({
  ticketdata: z.unknown().nullable(),
  description: z.string().nullable(),
  imageurl: z.string().nullable(),
});

/** A ProjectRegistration row exactly as Milltime returns it. Updates echo it back. */
export const RawTimeRowSchema = z
  .object({
    projectregistrationid: z.string(),
    regday: z.string(),
    projtimehh: z.number().nullable(),
    projtimemm: z.number().nullable(),
    projectid: z.string(),
    projectname: z.string(),
    activity: z.string(),
    activityname: z.string(),
    planningtaskid: z.string().nullable(),
    planningtaskname: z.string().nullable(),
    projectnr: z.string(),
    usernote: z.string().nullable(),
    internalnote: z.string().nullable(),
    timedistributiontype: z.string(),
    customernames: z.string(),
    absencetype: z.string().nullable(),
    attestlevel: z.number().nullable(),
    requirenote: z.boolean().nullable(),
    userid: z.string(),
    favoritetype: z.number().nullable(),
    phaseid: z.string(),
    phasename: z.string(),
    variationid: z.string().nullable(),
    billtimehh: z.number().nullable(),
    billtimemm: z.number().nullable(),
    projplandescription: z.string().nullable(),
    reportnr: z.number().nullable(),
    selfinvoicenr: z.number().nullable(),
    planningtype: z.number(),
    attendencelog: AttendenceLogSchema,
    ticket: TicketSchema,
  })
  .passthrough();

export type RawTimeRow = z.infer<typeof RawTimeRowSchema>;

export interface TimeRow {
  id: string;
  date: string;
  hours: number;
  project: { id: string; name: string; number: string; customer: string };
  activity: { id: string; name: string };
  task: { id: string; name: string | null } | null;
  /** e.g. "NORMALTIME", "TRAVELTIME1". */
  timeType: string;
  absenceType: string | null;
  note: string | null;
  internalNote: string | null;
  /** Locked (submitted) rows can no longer be changed by the user. */
  locked: boolean;
}

export function isLocked(attestLevel: number | null): boolean {
  return (attestLevel ?? 0) >= 1;
}

export function toTimeRow(raw: RawTimeRow): TimeRow {
  return {
    id: raw.projectregistrationid,
    date: raw.regday,
    hours: toHours(raw.projtimehh, raw.projtimemm),
    project: {
      id: raw.projectid,
      name: raw.projectname,
      number: raw.projectnr,
      customer: raw.customernames,
    },
    activity: { id: raw.activity, name: raw.activityname },
    task: raw.planningtaskid ? { id: raw.planningtaskid, name: raw.planningtaskname } : null,
    timeType: raw.timedistributiontype,
    absenceType: raw.absencetype,
    note: raw.usernote,
    internalNote: raw.internalnote,
    locked: isLocked(raw.attestlevel),
  };
}
