import type { CommandRunner } from "./command-runner.ts";
import { commandFailure } from "./command-runner.ts";
import type { SessionStore } from "./index.ts";
import type { SavedLogin } from "./saved-login.ts";
import { parseSavedLogin } from "./saved-login.ts";

const ATTRIBUTES = ["service", "milltime"];

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
