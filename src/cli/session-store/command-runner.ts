import { spawn } from "node:child_process";

export interface CommandResult {
  /** Exit code, or null when the command could not be started (e.g. not installed). */
  code: number | null;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[], input?: string) => Promise<CommandResult>;

export const runCommand: CommandRunner = (command, args, input) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => resolve({ code: null, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? "");
  });

export function commandFailure(command: string, result: CommandResult): Error {
  return new Error(`${command} failed (exit ${result.code}): ${result.stderr.trim()}`);
}
