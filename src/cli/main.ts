#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { MilltimeApiError, MilltimeHttpError, MilltimeNotLoggedInError } from "../types.ts";
import { registry as defaultRegistry } from "./commands/registry.ts";
import type { Command, Registry } from "./commands/registry.ts";
import type { CliContext } from "./context.ts";
import { UsageError } from "./errors.ts";
import { commandHelp, groupHelp, topLevelHelp } from "./help.ts";
import { createTerminalPrompt } from "./prompt.ts";
import { runCommand } from "./session-store/command-runner.ts";
import { configDir, selectSessionStore } from "./session-store/index.ts";
import type { SessionStoreSelection } from "./session-store/index.ts";
import { createSettingsStore } from "./settings.ts";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_NOT_LOGGED_IN = 3;

const GLOBAL_OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean" },
} as const;

/** Runs one CLI invocation and returns the exit code. */
export async function main(argv: string[], ctx: CliContext, registry: Registry = defaultRegistry): Promise<number> {
  try {
    return await dispatch(argv, ctx, registry);
  } catch (error) {
    return reportError(error, ctx);
  }
}

async function dispatch(argv: string[], ctx: CliContext, registry: Registry): Promise<number> {
  const [first, second, ...rest] = argv;
  if (first === undefined) {
    ctx.stderr(topLevelHelp(registry));
    return EXIT_USAGE;
  }
  if (first === "--version") return print(ctx, ctx.version);
  if (first === "--help") return print(ctx, topLevelHelp(registry));
  if (first === "help") return print(ctx, helpFor(registry, second, rest[0]));

  const group = registry[first];
  if (!group) throw new UsageError(`Unknown command "${first}".`);
  if (second === undefined || second === "--help") return print(ctx, groupHelp(registry, first));

  const command = group.commands[second];
  if (!command) throw new UsageError(`Unknown command "${first} ${second}".`);

  const { values, positionals } = parseCommandArgs(rest, command.options);
  if (values.help) return print(ctx, commandHelp(first, second, command));

  const output = await command.run({ values, positionals }, ctx);
  return print(ctx, values.json ? formatJson(output.data, ctx) : output.text);
}

function helpFor(registry: Registry, group: string | undefined, name: string | undefined): string {
  if (group === undefined) return topLevelHelp(registry);
  if (!registry[group]) throw new UsageError(`Unknown command "${group}".`);
  if (name === undefined) return groupHelp(registry, group);
  const command = registry[group].commands[name];
  if (!command) throw new UsageError(`Unknown command "${group} ${name}".`);
  return commandHelp(group, name, command);
}

function parseCommandArgs(args: string[], options: Command["options"]) {
  try {
    return parseArgs({ args, options: { ...options, ...GLOBAL_OPTIONS }, allowPositionals: true, strict: true });
  } catch (error) {
    // parseArgs reports unknown or malformed options as TypeErrors with an ERR_PARSE_ARGS_* code.
    if ((error as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS")) {
      throw new UsageError((error as Error).message);
    }
    throw error;
  }
}

function formatJson(data: unknown, ctx: CliContext): string {
  return ctx.stdoutIsTerminal ? JSON.stringify(data, null, 2) : JSON.stringify(data);
}

function print(ctx: CliContext, text: string): number {
  ctx.stdout(text);
  return EXIT_OK;
}

function reportError(error: unknown, ctx: CliContext): number {
  if (error instanceof UsageError) {
    ctx.stderr(`${error.message}\nRun "milltime help" for usage.`);
    return EXIT_USAGE;
  }
  if (error instanceof MilltimeNotLoggedInError) {
    ctx.stderr('Not logged in. Run "milltime auth login".');
    return EXIT_NOT_LOGGED_IN;
  }
  if (error instanceof MilltimeApiError || error instanceof MilltimeHttpError) {
    ctx.stderr(`Milltime error: ${error.message}`);
    return EXIT_ERROR;
  }
  ctx.stderr(`Error: ${error instanceof Error ? error.message : String(error)}`);
  return EXIT_ERROR;
}

function localDate(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function readVersion(): string {
  const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  return packageJson.version;
}

function createProcessContext(): CliContext {
  const environment = { env: process.env, platform: process.platform, homeDir: homedir(), run: runCommand };
  let selection: Promise<SessionStoreSelection> | undefined;
  return {
    stdout: (text) => console.log(text),
    stdoutIsTerminal: process.stdout.isTTY === true,
    stderr: (text) => console.error(text),
    today: localDate,
    version: readVersion(),
    fetch: globalThis.fetch,
    prompt: createTerminalPrompt(process.stdin, process.stderr),
    sessionStore: () => (selection ??= selectSessionStore(environment)),
    settings: createSettingsStore(configDir(environment)),
  };
}

if (import.meta.main) {
  const ctx = createProcessContext();
  process.exitCode = await main(process.argv.slice(2), ctx);
}
