import type { CommandRunner } from "./command-runner.ts";
import { commandFailure } from "./command-runner.ts";
import type { SessionStore } from "./index.ts";
import type { SavedLogin } from "./saved-login.ts";
import { parseSavedLogin } from "./saved-login.ts";

const ITEM = ["-s", "milltime", "-a", "milltime"];
// `security` exit code when the item does not exist.
const ITEM_NOT_FOUND = 44;

export function createMacosKeychainStore(run: CommandRunner): SessionStore {
  return {
    name: "macOS keychain",
    async load() {
      const result = await run("security", ["find-generic-password", ...ITEM, "-w"]);
      if (result.code === 0) return parseSavedLogin(result.stdout);
      if (result.code === ITEM_NOT_FOUND) return null;
      throw commandFailure("security find-generic-password", result);
    },
    async save(login: SavedLogin) {
      // `security -i` reads the command from stdin, keeping the secret out of argv; hex avoids quoting.
      const hex = Buffer.from(JSON.stringify(login)).toString("hex");
      const command = `add-generic-password -U ${ITEM.join(" ")} -l "Milltime session" -X ${hex}\n`;
      const result = await run("security", ["-i"], command);
      if (result.code !== 0 || result.stderr.trim() !== "") throw commandFailure("security add-generic-password", result);
    },
    async clear() {
      const result = await run("security", ["delete-generic-password", ...ITEM]);
      if (result.code !== 0 && result.code !== ITEM_NOT_FOUND) throw commandFailure("security delete-generic-password", result);
    },
  };
}
