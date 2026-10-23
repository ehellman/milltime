import type { Command, Registry } from "./commands/registry.ts";
import { formatColumns } from "./format/table.ts";

const GLOBAL_OPTIONS = `Global options:
  --json     Print JSON instead of text
  --help     Show help
  --version  Show the version`;

export function topLevelHelp(registry: Registry): string {
  const rows = Object.entries(registry).flatMap(([group, { commands }]) =>
    Object.entries(commands).map(([name, command]) => [`  ${group} ${name}`, command.summary]),
  );
  return [
    "Usage: milltime <group> <command> [options]",
    "",
    "Commands:",
    formatColumns(rows),
    "",
    GLOBAL_OPTIONS,
    "",
    'Run "milltime help <group> [command]" for details.',
  ].join("\n");
}

export function groupHelp(registry: Registry, group: string): string {
  const rows = Object.entries(registry[group].commands).map(([name, command]) => [`  ${name}`, command.summary]);
  return [
    `Usage: milltime ${group} <command> [options]`,
    "",
    registry[group].summary,
    "",
    "Commands:",
    formatColumns(rows),
  ].join("\n");
}

export function commandHelp(group: string, name: string, command: Command): string {
  const usage = ["Usage: milltime", group, name, command.usage, "[options]"].filter(Boolean).join(" ");
  return [usage, "", command.summary, ...(command.details ? ["", command.details] : []), "", GLOBAL_OPTIONS].join(
    "\n",
  );
}
