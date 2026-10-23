import { BREAKFAST_OPTIONS, DOMESTIC, MEAL_OPTIONS } from "../endpoints/allowances.ts";
import type { Breakfast, Meal, Meals } from "../endpoints/allowances.ts";
import type { AllowanceChanges, DayOverride, NewAllowance } from "../endpoints/allowance-writes.ts";
import { optionalString, parseDateArg } from "./args.ts";
import type { OptionValue } from "./args.ts";
import { UsageError } from "./errors.ts";

type Values = Record<string, OptionValue>;

function choice<T extends string>(value: string, options: readonly T[], name: string): T {
  if (!options.includes(value as T)) throw new UsageError(`Invalid ${name} "${value}". Use ${options.join(", ")}.`);
  return value as T;
}

function optionalChoice<T extends string>(value: OptionValue, options: readonly T[], name: string): T | undefined {
  const text = optionalString(value);
  return text === undefined ? undefined : choice(text, options, `--${name}`);
}

function yesNo(value: string, name: string): boolean {
  return choice(value, ["yes", "no"], name) === "yes";
}

function optionalYesNo(value: OptionValue, name: string): boolean | undefined {
  const text = optionalString(value);
  return text === undefined ? undefined : yesNo(text, `--${name}`);
}

function optionalDate(value: OptionValue, today: string): string | undefined {
  const text = optionalString(value);
  return text === undefined ? undefined : parseDateArg(text, today);
}

function partialMeals(values: Values): Partial<Meals> {
  const meals = {
    breakfast: optionalChoice<Breakfast>(values.breakfast, BREAKFAST_OPTIONS, "breakfast"),
    lunch: optionalChoice<Meal>(values.lunch, MEAL_OPTIONS, "lunch"),
    dinner: optionalChoice<Meal>(values.dinner, MEAL_OPTIONS, "dinner"),
  };
  return Object.fromEntries(Object.entries(meals).filter(([, meal]) => meal !== undefined));
}

/** "2026-10-20:accommodation=yes,lunch=employer" */
function parseDayOverride(text: string, today: string): [string, DayOverride] {
  const [dateText, settings = ""] = text.split(":", 2);
  if (!settings) throw new UsageError(`Invalid --day "${text}". Use <date>:<key>=<value>,…`);
  const fields: Values = {};
  for (const setting of settings.split(",")) {
    const [key, value] = setting.split("=", 2);
    choice(key, ["country", "accommodation", "breakfast", "lunch", "dinner"], `--day key in "${text}"`);
    if (!value) throw new UsageError(`Missing value for ${key} in --day "${text}".`);
    fields[key] = value;
  }
  const override: DayOverride = {
    country: optionalString(fields.country),
    privateAccommodation: optionalYesNo(fields.accommodation, "day accommodation"),
    meals: partialMeals(fields),
  };
  return [parseDateArg(dateText, today), override];
}

function dayOverrides(value: OptionValue, today: string): Record<string, DayOverride> | undefined {
  if (value === undefined) return undefined;
  const texts = Array.isArray(value) ? value : [String(value)];
  return Object.fromEntries(texts.map((text) => parseDayOverride(text, today)));
}

/** Every flag of `allowances add` and `edit`, all optional; `add` checks the required ones. */
export function parseAllowanceOptions(values: Values, today: string): AllowanceChanges {
  const departure = optionalChoice(values.departure, ["before-noon", "after-noon"], "departure");
  const back = optionalChoice(values.return, ["before-7pm", "after-7pm"], "return");
  const meals = partialMeals(values);
  const changes: AllowanceChanges = {
    from: optionalDate(values.from, today),
    to: optionalDate(values.to, today),
    departedBeforeNoon: departure && departure === "before-noon",
    returnedAfter7pm: back && back === "after-7pm",
    destination: optionalString(values.destination),
    purpose: optionalString(values.purpose),
    projectId: optionalString(values.project),
    country: optionalString(values.country),
    meals: Object.keys(meals).length > 0 ? meals : undefined,
    privateAccommodation: optionalYesNo(values["private-accommodation"], "private-accommodation"),
    days: dayOverrides(values.day, today),
  };
  return Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
}

const REQUIRED_FOR_ADD = [
  "from",
  "to",
  "departure",
  "return",
  "destination",
  "purpose",
  "project",
  "breakfast",
  "lunch",
  "dinner",
  "private-accommodation",
];

/** Lists every missing flag at once, so nothing that changes the amount is guessed. */
export function parseNewAllowance(values: Values, today: string): NewAllowance {
  const missing = REQUIRED_FOR_ADD.filter((name) => optionalString(values[name]) === undefined);
  if (missing.length > 0) throw new UsageError(`Missing ${missing.map((name) => `--${name}`).join(", ")}.`);
  const changes = parseAllowanceOptions(values, today);
  return {
    from: changes.from!,
    to: changes.to!,
    departedBeforeNoon: changes.departedBeforeNoon!,
    returnedAfter7pm: changes.returnedAfter7pm!,
    destination: changes.destination!,
    purpose: changes.purpose!,
    projectId: changes.projectId!,
    country: changes.country ?? DOMESTIC,
    meals: changes.meals as Meals,
    privateAccommodation: changes.privateAccommodation!,
    days: changes.days,
  };
}
