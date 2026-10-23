import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionStore } from "./index.ts";
import type { SavedLogin } from "./saved-login.ts";
import { parseSavedLogin } from "./saved-login.ts";

export function createFileStore(dir: string): SessionStore {
  const path = join(dir, "session.json");
  return {
    name: path,
    async load() {
      try {
        return parseSavedLogin(await readFile(path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async save(login: SavedLogin) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(path, JSON.stringify(login), { mode: 0o600 });
      // writeFile keeps the mode of an existing file.
      await chmod(path, 0o600);
    },
    async clear() {
      await rm(path, { force: true });
    },
  };
}
