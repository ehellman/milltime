import type { ParseArgsOptionsConfig } from "node:util";
import type { OptionValue } from "../args.ts";
import type { CliContext } from "../context.ts";
import { allowances } from "./allowances.ts";
import { auth } from "./auth.ts";
import { expenses } from "./expenses.ts";
import { lock } from "./lock.ts";
import { time } from "./time.ts";

export interface CommandInput {
  positionals: string[];
  values: Record<string, OptionValue>;
}

/** `data` is printed for --json, `text` otherwise. */
export interface CommandOutput {
  data: unknown;
  text: string;
}

export interface Command {
  summary: string;
  /** Arguments after the command name, e.g. "[week]". */
  usage?: string;
  /** Extra help: arguments and options. */
  details?: string;
  options?: ParseArgsOptionsConfig;
  run(input: CommandInput, ctx: CliContext): Promise<CommandOutput>;
}

export interface CommandGroup {
  summary: string;
  commands: Record<string, Command>;
}

export type Registry = Record<string, CommandGroup>;

export const registry: Registry = { auth, time, lock, expenses, allowances };
