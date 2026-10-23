import { join } from "node:path";
import type { CommandRunner } from "./command-runner.ts";
import { commandFailure } from "./command-runner.ts";
import type { SessionStore, SessionStoreEnvironment } from "./index.ts";
import type { SavedLogin } from "./saved-login.ts";
import { parseSavedLogin } from "./saved-login.ts";

const ATTRIBUTES = ["service", "milltime"];

/**
 * Some MCP clients (e.g. Codex) start servers with a minimal environment that leaves out
 * DBUS_SESSION_BUS_ADDRESS, so secret-tool cannot reach the keyring. Falls back to the user's standard bus.
 */
export function secretToolRunner({ env, uid, fileExists, run }: SessionStoreEnvironment): CommandRunner {
  if (env.DBUS_SESSION_BUS_ADDRESS || uid === undefined) return run;
  const bus = join(env.XDG_RUNTIME_DIR || `/run/user/${uid}`, "bus");
  if (!fileExists(bus)) return run;
  const busEnv = { ...env, DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}` };
  return (command, args, input) => run(command, args, input, busEnv);
}

/** Installed and connected to a secret service: a lookup of a missing item exits 1 with no error output. */
export async function isSecretToolAvailable(run: CommandRunner): Promise<boolean> {
  const result = await run("secret-tool", ["lookup", "service", "milltime-probe"]);
  return result.code !== null && result.stderr.trim() === "";
}

export function createSecretToolStore(run: CommandRunner): SessionStore {
  return {
    name: "Secret Service keyring (secret-tool)",
    async load() {
      const result = await run("secret-tool", ["lookup", ...ATTRIBUTES]);
      if (result.code === 0) return parseSavedLogin(result.stdout);
      if (result.code === 1 && result.stderr.trim() === "") return null;
      throw commandFailure("secret-tool lookup", result);
    },
    async save(login: SavedLogin) {
      // The secret goes through stdin, never argv.
      const result = await run("secret-tool", ["store", "--label=Milltime session", ...ATTRIBUTES], JSON.stringify(login));
      if (result.code !== 0) throw commandFailure("secret-tool store", result);
    },
    async clear() {
      const result = await run("secret-tool", ["clear", ...ATTRIBUTES]);
      if (result.code !== 0 && result.stderr.trim() !== "") throw commandFailure("secret-tool clear", result);
    },
  };
}
