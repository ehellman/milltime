import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MilltimeClient } from "../../client.ts";
import {
  createAllowance,
  deleteAllowance,
  planCreateAllowance,
  planDeleteAllowance,
  planUpdateAllowance,
  updateAllowance,
} from "../../endpoints/allowance-writes.ts";
import type { AllowanceChanges, DayOverride, NewAllowance } from "../../endpoints/allowance-writes.ts";
import { BREAKFAST_OPTIONS, DOMESTIC, MEAL_OPTIONS } from "../../endpoints/allowances.ts";
import type { Breakfast, Meal, Meals } from "../../endpoints/allowances.ts";
import { listAllowanceProjects } from "../../endpoints/reference.ts";
import { confirmedWrite } from "../confirm.ts";
import type { McpContext } from "../context.ts";
import { errorResult, handleErrors } from "../result.ts";
import { confirmToken, date } from "../schemas.ts";

const BREAKFAST_HELP =
  "paid-myself, hotel (included in the hotel price), ticket (included in a ticket price), employer (paid by the employer)";
const MEAL_HELP =
  "paid-myself, deduction (meal deduction, måltidsavdrag), ticket (included in a ticket price), employer (paid by the employer)";

/** What to ask the user for each field `create_allowance` needs. */
const REQUIRED = {
  from: "the departure day (YYYY-MM-DD)",
  to: "the return day (YYYY-MM-DD)",
  departedBeforeNoon: "did they leave before 12:00 on the departure day? (true/false)",
  returnedAfter7pm: "did they get back after 19:00 on the return day? (true/false)",
  destination: "where they went",
  purpose: "why they went",
  projectId: "which project; list_allowance_projects lists them",
  breakfast: `who paid breakfast on most days: ${BREAKFAST_HELP}`,
  lunch: `who paid lunch on most days: ${MEAL_HELP}`,
  dinner: `who paid dinner on most days: ${MEAL_HELP}`,
  privateAccommodation: "did they stay privately (not in a hotel or paid lodging) every night? (true/false)",
} as const;

const breakfast = z.enum(BREAKFAST_OPTIONS as [Breakfast, ...Breakfast[]]);
const meal = z.enum(MEAL_OPTIONS as [Meal, ...Meal[]]);
const country = z.string().describe('Country code from list_countries, or "domestic"');

const dayInput = z.object({
  date,
  country: country.optional(),
  privateAccommodation: z.boolean().optional().describe("Stayed privately the night before this day"),
  breakfast: breakfast.optional(),
  lunch: meal.optional(),
  dinner: meal.optional(),
});
type DayInput = z.infer<typeof dayInput>;

/** Every field optional, so the handler can list all that are missing at once instead of the SDK failing on the first. */
const tripInput = {
  from: date.optional().describe(REQUIRED.from),
  to: date.optional().describe(REQUIRED.to),
  departedBeforeNoon: z.boolean().optional().describe(REQUIRED.departedBeforeNoon),
  returnedAfter7pm: z.boolean().optional().describe(REQUIRED.returnedAfter7pm),
  destination: z.string().optional().describe(REQUIRED.destination),
  purpose: z.string().optional().describe(REQUIRED.purpose),
  projectId: z.string().optional().describe(REQUIRED.projectId),
  country: country.optional().describe('Where the trip went: a code from list_countries, default "domestic"'),
  breakfast: breakfast.optional().describe(`Every day: ${BREAKFAST_HELP}`),
  lunch: meal.optional().describe(`Every day: ${MEAL_HELP}`),
  dinner: meal.optional().describe(`Every day: ${MEAL_HELP}`),
  privateAccommodation: z
    .boolean()
    .optional()
    .describe("Stayed privately every night. Nights count on the day after, so never on the departure day"),
  days: z.array(dayInput).optional().describe("Exceptions for single days of the trip"),
};
type TripInput = { [K in keyof typeof tripInput]: z.infer<(typeof tripInput)[K]> };

const allowanceRef = {
  date: date.describe("Any day of the trip"),
  id: z.string().describe("The allowance's id, from list_allowances"),
};

const TRIP_RULES =
  "The departure day never has private accommodation; a night counts on the day after it. " +
  "Milltime computes the compensation; never compute or promise an amount.";

function partialMeals(input: Partial<Meals>): Partial<Meals> | undefined {
  const meals = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  return Object.keys(meals).length > 0 ? meals : undefined;
}

function dayOverrides(days: DayInput[] | undefined): Record<string, DayOverride> | undefined {
  if (days === undefined) return undefined;
  return Object.fromEntries(
    days.map(({ date, country, privateAccommodation, breakfast, lunch, dinner }) => [
      date,
      { country, privateAccommodation, meals: partialMeals({ breakfast, lunch, dinner }) },
    ]),
  );
}

function toChanges(input: TripInput): AllowanceChanges {
  const { breakfast, lunch, dinner, days, ...trip } = input;
  const changes: AllowanceChanges = {
    ...trip,
    meals: partialMeals({ breakfast, lunch, dinner }),
    days: dayOverrides(days),
  };
  return Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
}

function missingFields(input: TripInput): string[] {
  return Object.entries(REQUIRED)
    .filter(([field]) => input[field as keyof TripInput] === undefined)
    .map(([field, question]) => `- ${field}: ${question}`);
}

function toNewAllowance(input: TripInput): NewAllowance {
  const changes = toChanges(input);
  return { ...changes, country: changes.country ?? DOMESTIC } as NewAllowance;
}

async function assertAllowanceProject(client: MilltimeClient, projectId: string | undefined): Promise<void> {
  if (projectId === undefined) return;
  if (!(await listAllowanceProjects(client)).some((project) => project.id === projectId)) {
    throw new Error(`No allowance project with id "${projectId}". Call list_allowance_projects to list them.`);
  }
}

export function registerAllowanceWriteTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    "create_allowance",
    {
      description:
        "Add an allowance (traktamente) for a business trip. Values apply to every day; `days` holds exceptions. " +
        "Every field except country and days is required: when any is missing the tool lists them all; ask the user " +
        `rather than assume. ${TRIP_RULES}`,
      inputSchema: { ...tripInput, confirmToken },
      annotations: { destructiveHint: false },
    },
    ({ confirmToken: token, ...input }) =>
      handleErrors(async () => {
        const missing = missingFields(input);
        if (missing.length > 0) {
          return errorResult(
            ["Missing:", ...missing, "Ask the user for these; do not assume. Per-day exceptions go in days."].join(
              "\n",
            ),
          );
        }
        const allowance = toNewAllowance(input);
        return ctx.withClient(async (client) => {
          await assertAllowanceProject(client, allowance.projectId);
          const plan = await planCreateAllowance(client, allowance);
          return confirmedWrite(ctx, "create_allowance", token, [plan], () => createAllowance(client, allowance));
        });
      }),
  );

  server.registerTool(
    "update_allowance",
    {
      description:
        "Change an allowance. Trip-wide values apply to every day, then `days`. Changing from/to keeps existing days; " +
        `new days copy the nearest one. ${TRIP_RULES}`,
      inputSchema: { ...allowanceRef, ...tripInput, confirmToken },
    },
    ({ date, id, confirmToken: token, ...input }) =>
      handleErrors(async () => {
        const changes = toChanges(input);
        if (Object.keys(changes).length === 0) return errorResult("Nothing to change.");
        const allowance = { id, from: date };
        return ctx.withClient(async (client) => {
          await assertAllowanceProject(client, changes.projectId);
          const plan = await planUpdateAllowance(client, allowance, changes);
          return confirmedWrite(ctx, "update_allowance", token, [plan], () =>
            updateAllowance(client, allowance, changes),
          );
        });
      }),
  );

  server.registerTool(
    "delete_allowance",
    {
      description: "Delete an allowance.",
      inputSchema: { ...allowanceRef, confirmToken },
      annotations: { destructiveHint: true },
    },
    ({ date, id, confirmToken: token }) =>
      handleErrors(() =>
        ctx.withClient(async (client) => {
          const allowance = { id, from: date };
          const plan = await planDeleteAllowance(client, allowance);
          return confirmedWrite(ctx, "delete_allowance", token, [plan], () => deleteAllowance(client, allowance));
        }),
      ),
  );
}
