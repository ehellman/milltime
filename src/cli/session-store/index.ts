import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "./command-runner.ts";
import { runCommand } from "./command-runner.ts";
import { createFileStore } from "./file.ts";
import { createMacosKeychainStore } from "./macos-keychain.ts";
import { createSecretToolStore, isSecretToolAvailable, secretToolRunner } from "./secret-tool.ts";
import type { SavedLogin } from "./saved-login.ts";

export type { SavedLogin } from "./saved-login.ts";

export interface SessionStore {
  /** Human-readable backend name for `auth status`. */
  readonly name: string;
  load(): Promise<SavedLogin | null>;
  save(login: SavedLogin): Promise<void>;
  clear(): Promise<void>;
}

export interface SessionStoreSelection {
  store: SessionStore;
  /** Set when falling back to a plain file because no keychain is available. */
  warning?: string;
  /** Why a login saved in a keychain may not be found, set with `warning`. */
  missingLoginHint?: string;
}

export interface SessionStoreEnvironment {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDir: string;
  /** Undefined on Windows. */
  uid: number | undefined;
  fileExists: (path: string) => boolean;
  run: CommandRunner;
}

export function processEnvironment(): SessionStoreEnvironment {
  return {
    env: process.env,
    platform: process.platform,
    homeDir: homedir(),
    uid: process.getuid?.(),
    fileExists: existsSync,
    run: runCommand,
  };
}

/** `$MILLTIME_CONFIG_DIR`, else `$XDG_CONFIG_HOME/milltime`, else `~/.config/milltime`. */
export function configDir({ env, homeDir }: Pick<SessionStoreEnvironment, "env" | "homeDir">): string {
  if (env.MILLTIME_CONFIG_DIR) return env.MILLTIME_CONFIG_DIR;
  return join(env.XDG_CONFIG_HOME || join(homeDir, ".config"), "milltime");
}

/** Keychain when available, otherwise a 0600 file. `MILLTIME_CONFIG_DIR` forces the file. */
export async function selectSessionStore(environment: SessionStoreEnvironment): Promise<SessionStoreSelection> {
  const fileStore = createFileStore(configDir(environment));
  if (environment.env.MILLTIME_CONFIG_DIR) return { store: fileStore };
  if (environment.platform === "darwin") return { store: createMacosKeychainStore(environment.run) };
  if (environment.platform === "linux") {
    const run = secretToolRunner(environment);
    if (await isSecretToolAvailable(run)) return { store: createSecretToolStore(run) };
  }
  return {
    store: fileStore,
    warning: `No keychain available; the session is stored in ${fileStore.name} (readable only by you).`,
    missingLoginHint:
      `No keychain was reachable, so only ${fileStore.name} was checked. A login saved in the keychain needs it ` +
      "reachable here (on Linux, DBUS_SESSION_BUS_ADDRESS); or set MILLTIME_CONFIG_DIR both here and when logging in.",
  };
}
