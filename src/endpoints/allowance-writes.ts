import type { MilltimeClient } from "../client.ts";
import { datesInRange, localMidnightIso, localToday } from "../dates.ts";
import { filterQuery } from "../filters.ts";
import { sendPlanned } from "../planned.ts";
import type { PlannedRequest } from "../planned.ts";
import {
  ALLOWANCE_PATH,
  DEPARTURE,
  DOMESTIC,
  RETURN,
  encodeDayCountry,
  encodeMeals,
  encodeNightCountry,
  findRawAllowance,
  parseAllowanceRows,
  toAllowance,
} from "./allowances.ts";
import type { Allowance, Meals, RawAllowance } from "./allowances.ts";
import { getCalendar } from "./calendar.ts";
import { listCountries } from "./reference.ts";
import type { Country } from "./reference.ts";

export interface DayOverride {
  /** DOMESTIC or a country code. */
  country?: string;
  /** Stayed privately the night before this day, in the day's country. Not allowed on the first day. */
  privateAccommodation?: boolean;
  meals?: Partial<Meals>;
}

/** Every field that changes the amount is required: callers ask the user rather than guess. */
export interface NewAllowance {
  from: string; // "YYYY-MM-DD", the departure day
  to: string; // the return day
  departedBeforeNoon: boolean;
  returnedAfter7pm: boolean;
  destination: string;
  purpose: string;
  projectId: string;
  /** DOMESTIC or a country code, for every day unless overridden. */
  country: string;
  /** For every day unless overridden. */
  meals: Meals;
  /** Stayed privately every night of the trip. */
  privateAccommodation: boolean;
  /** Per-day exceptions, keyed by date. */
  days?: Record<string, DayOverride>;
}

/** Trip-level values apply to every day, then `days`. Days added by moving `from`/`to` copy the nearest existing day. */
export interface AllowanceChanges {
  from?: string;
  to?: string;
  departedBeforeNoon?: boolean;
  returnedAfter7pm?: boolean;
  destination?: string;
  purpose?: string;
  projectId?: string;
  country?: string;
  meals?: Partial<Meals>;
  privateAccommodation?: boolean;
  days?: Record<string, DayOverride>;
}

interface TripDay {
  date: string;
  country: string;
  privateAccommodation: string | null;
  meals: Meals;
}

interface Trip {
  from: string;
  to: string;
  departedBeforeNoon: boolean;
  returnedAfter7pm: boolean;
  destination: string;
  purpose: string;
  projectId: string;
  days: TripDay[];
}

// ---------------------------------------------------------------------------
// Building the days
// ---------------------------------------------------------------------------

function tripDates(from: string, to: string): string[] {
  if (from > to) throw new Error(`The trip ends (${to}) before it starts (${from})`);
  return datesInRange({ from, to });
}

function applyOverrides(days: TripDay[], overrides: Record<string, DayOverride> = {}): TripDay[] {
  for (const date of Object.keys(overrides)) {
    if (!days.some((day) => day.date === date)) throw new Error(`${date} is not a day of the trip`);
  }
  if (overrides[days[0].date]?.privateAccommodation) {
    throw new Error(`No private accommodation on the departure day ${days[0].date}: a night counts on the day after it`);
  }
  return days.map((day) => {
    const override = overrides[day.date];
    if (!override) return day;
    const country = override.country ?? day.country;
    const accommodation = override.privateAccommodation ?? day.privateAccommodation !== null;
    return {
      ...day,
      country,
      privateAccommodation: accommodation ? country : null,
      meals: { ...day.meals, ...override.meals },
    };
  });
}

/** The first day never has private accommodation, like the web UI. */
function withoutFirstNight(days: TripDay[]): TripDay[] {
  return days.map((day, i) => (i === 0 ? { ...day, privateAccommodation: null } : day));
}

function newTrip(allowance: NewAllowance): Trip {
  const days = tripDates(allowance.from, allowance.to).map((date) => ({
    date,
    country: allowance.country,
    privateAccommodation: allowance.privateAccommodation ? allowance.country : null,
    meals: allowance.meals,
  }));
  return {
    from: allowance.from,
    to: allowance.to,
    departedBeforeNoon: allowance.departedBeforeNoon,
    returnedAfter7pm: allowance.returnedAfter7pm,
    destination: allowance.destination,
    purpose: allowance.purpose,
    projectId: allowance.projectId,
    days: withoutFirstNight(applyOverrides(withoutFirstNight(days), allowance.days)),
  };
}

function nearestDay(days: TripDay[], date: string): TripDay {
  return days.find((day) => day.date === date) ?? (date < days[0].date ? days[0] : days.at(-1)!);
}

function sameForAllDays<T>(allowance: Allowance, value: (day: Allowance["days"][number]) => T, flag: string): T {
  const values = new Set(allowance.days.map(value));
  if (values.size > 1) throw new Error(`Allowance ${allowance.id} has a different ${flag} per day; set ${flag} to edit it`);
  return value(allowance.days[0]);
}

function changedTrip(allowance: Allowance, changes: AllowanceChanges): Trip {
  const existing = allowance.days.map(({ date, country, privateAccommodation, meals }) => ({
    date,
    country,
    privateAccommodation,
    meals,
  }));
  const from = changes.from ?? allowance.from;
  const to = changes.to ?? allowance.to;
  const days = tripDates(from, to).map((date) => {
    const base = { ...nearestDay(existing, date), date };
    const country = changes.country ?? base.country;
    const accommodation = changes.privateAccommodation ?? base.privateAccommodation !== null;
    return {
      date,
      country,
      privateAccommodation: accommodation ? (changes.country ?? base.privateAccommodation ?? country) : null,
      meals: { ...base.meals, ...changes.meals },
    };
  });
  return {
    from,
    to,
    departedBeforeNoon: changes.departedBeforeNoon ?? allowance.departedBeforeNoon,
    returnedAfter7pm: changes.returnedAfter7pm ?? allowance.returnedAfter7pm,
    destination: changes.destination ?? sameForAllDays(allowance, (day) => day.destination, "destination"),
    purpose: changes.purpose ?? allowance.purpose,
    projectId: changes.projectId ?? sameForAllDays(allowance, (day) => day.projectId, "project"),
    days: withoutFirstNight(applyOverrides(withoutFirstNight(days), changes.days)),
  };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** Maps the home country's code to DOMESTIC and refuses unknown codes. */
function normalizeCountry(countries: Country[], code: string): string {
  if (code === DOMESTIC) return code;
  const country = countries.find((c) => c.code === code.toUpperCase());
  if (!country) throw new Error(`Unknown country "${code}"`);
  return country.isDefault ? DOMESTIC : country.code;
}

async function withKnownCountries(client: MilltimeClient, trip: Trip): Promise<Trip> {
  const countries = await listCountries(client);
  const normalize = (code: string) => normalizeCountry(countries, code);
  return {
    ...trip,
    days: trip.days.map((day) => ({
      ...day,
      country: normalize(day.country),
      privateAccommodation: day.privateAccommodation === null ? null : normalize(day.privateAccommodation),
    })),
  };
}

async function assertDaysUnlocked(client: MilltimeClient, trip: Trip): Promise<void> {
  const calendar = await getCalendar(client, { from: trip.from, to: trip.to });
  const locked = calendar.filter((day) => day.locked && day.date >= trip.from && day.date <= trip.to);
  if (locked.length > 0) throw new Error(`Locked days in the trip: ${locked.map((day) => day.date).join(", ")}`);
}

async function readUnlockedAllowance(
  client: MilltimeClient,
  allowance: Pick<Allowance, "id" | "from">,
): Promise<RawAllowance> {
  const raw = await findRawAllowance(client, allowance.from, allowance.id);
  if (toAllowance(raw).locked) throw new Error(`Allowance ${allowance.id} has locked days`);
  return raw;
}

async function checkedTrip(client: MilltimeClient, trip: Trip): Promise<Trip> {
  const checked = await withKnownCountries(client, trip);
  await assertDaysUnlocked(client, checked);
  return checked;
}

// ---------------------------------------------------------------------------
// Payloads — mirror what the web UI sends (see tests/fixtures/allowance-*.json)
// ---------------------------------------------------------------------------

function buildDays(trip: Trip): Record<string, unknown>[] {
  const last = trip.days.length - 1;
  return trip.days.map((day, i) => ({
    regday: day.date,
    daycountrycode: encodeDayCountry(day.country),
    nightcountrycode: encodeNightCountry(day.privateAccommodation),
    ...encodeMeals(day.meals),
    destination: trip.destination,
    attestlevel: 0,
    night: day.privateAccommodation !== null,
    projectid: trip.projectId,
    ...(i === 0 && { deptime: trip.departedBeforeNoon ? DEPARTURE.beforeNoon : DEPARTURE.afterNoon }),
    ...(i === last && { arrtime: trip.returnedAfter7pm ? RETURN.after7pm : RETURN.before7pm }),
  }));
}

function buildPayload(trip: Trip, stored: { id: string; projectId: string; totalCompensation: number }) {
  return {
    attestlevel: 0,
    updated: true,
    validate: true,
    totalcompensation: stored.totalCompensation,
    period: { _from: localMidnightIso(trip.from), _to: localMidnightIso(trip.to) },
    allowanceid: stored.id,
    purpose: trip.purpose,
    projectid: stored.projectId,
    regday: localToday(),
    allowancedays: buildDays(trip),
  };
}

function buildCreatePayload(trip: Trip): Record<string, unknown> {
  return buildPayload(trip, { id: "", projectId: trip.projectId, totalCompensation: 0 });
}

/** The web UI sends an empty top-level `projectid` on edits; the days carry the project. */
function buildUpdatePayload(trip: Trip, raw: RawAllowance): Record<string, unknown> {
  return buildPayload(trip, { id: raw.allowanceid, projectId: "", totalCompensation: raw.totalcompensation });
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

function describeDay(day: TripDay): string {
  const accommodation = day.privateAccommodation === null ? "" : `, private accommodation ${day.privateAccommodation}`;
  const { breakfast, lunch, dinner } = day.meals;
  return `  ${day.date} ${day.country}${accommodation}; breakfast ${breakfast}, lunch ${lunch}, dinner ${dinner}`;
}

function describeTrip(trip: Trip): string {
  const departure = trip.departedBeforeNoon ? "before 12" : "after 12";
  const arrival = trip.returnedAfter7pm ? "after 19" : "before 19";
  return [
    `${trip.from} – ${trip.to} to ${trip.destination} (${trip.purpose}), project ${trip.projectId}`,
    `  left ${departure}, back ${arrival}`,
    ...trip.days.map(describeDay),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

export async function planCreateAllowance(client: MilltimeClient, allowance: NewAllowance): Promise<PlannedRequest> {
  const trip = await checkedTrip(client, newTrip(allowance));
  return {
    method: "POST",
    path: ALLOWANCE_PATH,
    body: buildCreatePayload(trip),
    summary: `Add allowance ${describeTrip(trip)}`,
  };
}

function savedAllowance(rows: unknown[] | undefined): Allowance {
  const [raw] = parseAllowanceRows(rows);
  if (!raw) throw new Error("Milltime did not return the saved allowance");
  return toAllowance(raw);
}

/** Milltime computes the compensation; the returned allowance carries it. */
export async function createAllowance(client: MilltimeClient, allowance: NewAllowance): Promise<Allowance> {
  return savedAllowance((await sendPlanned(client, await planCreateAllowance(client, allowance))).rows);
}

export async function planUpdateAllowance(
  client: MilltimeClient,
  allowance: Pick<Allowance, "id" | "from">,
  changes: AllowanceChanges,
): Promise<PlannedRequest> {
  const raw = await readUnlockedAllowance(client, allowance);
  const trip = await checkedTrip(client, changedTrip(toAllowance(raw), changes));
  return {
    method: "PUT",
    path: ALLOWANCE_PATH,
    query: filterQuery(["id", "=", allowance.id]),
    body: buildUpdatePayload(trip, raw),
    summary: `Update allowance ${allowance.id}: ${describeTrip(trip)}`,
  };
}

export async function updateAllowance(
  client: MilltimeClient,
  allowance: Pick<Allowance, "id" | "from">,
  changes: AllowanceChanges,
): Promise<Allowance> {
  return savedAllowance((await sendPlanned(client, await planUpdateAllowance(client, allowance, changes))).rows);
}

export async function planDeleteAllowance(
  client: MilltimeClient,
  allowance: Pick<Allowance, "id" | "from">,
): Promise<PlannedRequest> {
  const current = toAllowance(await readUnlockedAllowance(client, allowance));
  return {
    method: "DELETE",
    path: ALLOWANCE_PATH,
    query: filterQuery(["id", "=", allowance.id]),
    summary: `Delete allowance ${current.from} – ${current.to} to ${current.destination} (${current.totalCompensation})`,
  };
}

export async function deleteAllowance(client: MilltimeClient, allowance: Pick<Allowance, "id" | "from">): Promise<void> {
  await sendPlanned(client, await planDeleteAllowance(client, allowance));
}
