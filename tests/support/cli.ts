import type { CliContext } from "../../src/cli/context.ts";
import type { Prompt } from "../../src/cli/prompt.ts";
import type { SavedLogin, SessionStore } from "../../src/cli/session-store/index.ts";
import type { Settings, SettingsStore } from "../../src/cli/settings.ts";
import { FakeMilltime, storedSession } from "./fake-milltime.ts";

export interface CapturedCli {
  ctx: CliContext;
  stdout: string[];
  stderr: string[];
  store: MemorySessionStore;
  settings: MemorySettingsStore;
  prompt: ScriptedPrompt;
}

export class MemorySessionStore implements SessionStore {
  readonly name = "test keychain";
  saved: SavedLogin | null = null;
  saveCount = 0;
  async load() {
    return this.saved;
  }
  async save(login: SavedLogin) {
    this.saved = structuredClone(login);
    this.saveCount += 1;
  }
  async clear() {
    this.saved = null;
  }
}

export class MemorySettingsStore implements SettingsStore {
  settings: Settings = {};
  async load() {
    return this.settings;
  }
  async save(settings: Settings) {
    this.settings = settings;
  }
}

/** Answers prompts from a script and records the questions. */
export class ScriptedPrompt implements Prompt {
  readonly questions: string[] = [];
  private readonly answers: string[];
  constructor(answers: string[] = []) {
    this.answers = answers;
  }
  async line(question: string, defaultValue?: string) {
    this.questions.push(defaultValue ? `${question} [${defaultValue}]` : question);
    return this.next() || defaultValue || "";
  }
  async password(question: string) {
    this.questions.push(question);
    return this.next();
  }
  private next(): string {
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error("Unexpected prompt");
    return answer;
  }
}

export interface CaptureOptions {
  server?: FakeMilltime;
  answers?: string[];
  /** Pre-saves this login, as if `auth login` had run. */
  login?: SavedLogin;
  storeWarning?: string;
  overrides?: Partial<CliContext>;
}

export function savedLogin(overrides: Partial<SavedLogin> = {}): SavedLogin {
  return {
    baseUrl: "https://milltime.test",
    instanceId: "000123.1",
    username: "user",
    session: storedSession(),
    ...overrides,
  };
}

export function captureCli(options: CaptureOptions = {}): CapturedCli {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const store = new MemorySessionStore();
  store.saved = options.login ?? null;
  const settings = new MemorySettingsStore();
  const prompt = new ScriptedPrompt(options.answers);
  const server = options.server ?? new FakeMilltime();
  const ctx: CliContext = {
    stdout: (text) => stdout.push(text),
    stdoutIsTerminal: false,
    stderr: (text) => stderr.push(text),
    today: () => "2026-10-22",
    version: "1.2.3",
    fetch: server.fetch,
    prompt,
    sessionStore: async () => ({ store, warning: options.storeWarning }),
    settings,
    ...options.overrides,
  };
  return { ctx, stdout, stderr, store, settings, prompt };
}
