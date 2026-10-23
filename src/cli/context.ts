import type { Prompt } from "./prompt.ts";
import type { SessionStoreSelection } from "./session-store/index.ts";
import type { SettingsStore } from "./settings.ts";

/** Everything a command touches outside its arguments, injectable for tests. */
export interface CliContext {
  stdout: (text: string) => void;
  /** Pretty-print --json output for a person; keep it compact for scripts and agents. */
  stdoutIsTerminal: boolean;
  stderr: (text: string) => void;
  /** Today as "YYYY-MM-DD" in local time. */
  today: () => string;
  version: string;
  fetch: typeof fetch;
  prompt: Prompt;
  /** Selected lazily: probing the keychain spawns a process. */
  sessionStore: () => Promise<SessionStoreSelection>;
  settings: SettingsStore;
}
