import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Non-secret defaults for `auth login`. */
export interface Settings {
  baseUrl?: string;
  instanceId?: string;
  username?: string;
}

export interface SettingsStore {
  load(): Promise<Settings>;
  save(settings: Settings): Promise<void>;
}

export function createSettingsStore(dir: string): SettingsStore {
  const path = join(dir, "config.json");
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, "utf8")) as Settings;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw error;
      }
    },
    async save(settings) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`);
    },
  };
}
