import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, CommandRunner } from "../../../src/cli/session-store/command-runner.ts";
import { createFileStore } from "../../../src/cli/session-store/file.ts";
import { configDir, selectSessionStore } from "../../../src/cli/session-store/index.ts";
import type { SavedLogin } from "../../../src/cli/session-store/index.ts";
import { createMacosKeychainStore } from "../../../src/cli/session-store/macos-keychain.ts";
import { createSecretToolStore } from "../../../src/cli/session-store/secret-tool.ts";
import { storedSession } from "../../support/fake-milltime.ts";

const LOGIN: SavedLogin = {
  baseUrl: "https://milltime.test",
  instanceId: "000123.1",
  username: "user",
  session: storedSession({ expiresAt: 1_800_000_000_000 }),
};

interface RecordedCommand {
  command: string;
  args: string[];
  input?: string;
  env?: NodeJS.ProcessEnv;
}

/** Answers commands in order and records what was run. */
function fakeRunner(...results: Partial<CommandResult>[]): { run: CommandRunner; calls: RecordedCommand[] } {
  const calls: RecordedCommand[] = [];
  const run: CommandRunner = async (command, args, input, env) => {
    calls.push(env ? { command, args, input, env } : { command, args, input });
    const result = results.shift();
    if (!result) throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    return { code: 0, stdout: "", stderr: "", ...result };
  };
  return { run, calls };
}

describe("file session store", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "milltime-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("saves and loads a login with owner-only permissions", async () => {
    const configPath = join(dir, "milltime");
    const store = createFileStore(configPath);

    await store.save(LOGIN);

    assert.deepEqual(await store.load(), LOGIN);
    assert.equal((await stat(configPath)).mode & 0o777, 0o700);
    assert.equal((await stat(join(configPath, "session.json"))).mode & 0o777, 0o600);
  });

  it("tightens the permissions of an existing file", async () => {
    const path = join(dir, "session.json");
    await writeFile(path, "{}", { mode: 0o644 });

    await createFileStore(dir).save(LOGIN);

    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });

  it("loads nothing when the file is missing or unreadable", async () => {
    const store = createFileStore(dir);
    assert.equal(await store.load(), null);

    await writeFile(join(dir, "session.json"), "not json");
    assert.equal(await store.load(), null);
  });

  it("clears the file, also when it does not exist", async () => {
    const store = createFileStore(dir);
    await store.save(LOGIN);

    await store.clear();
    await store.clear();

    assert.equal(await store.load(), null);
  });

  it("never stores anything but the login", async () => {
    await createFileStore(dir).save(LOGIN);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "session.json"), "utf8")), LOGIN);
  });
});

describe("secret-tool session store", () => {
  it("stores the login through stdin", async () => {
    const { run, calls } = fakeRunner({});

    await createSecretToolStore(run).save(LOGIN);

    assert.deepEqual(calls, [
      {
        command: "secret-tool",
        args: ["store", "--label=Milltime session", "service", "milltime"],
        input: JSON.stringify(LOGIN),
      },
    ]);
  });

  it("loads a stored login", async () => {
    const { run, calls } = fakeRunner({ stdout: JSON.stringify(LOGIN) });

    assert.deepEqual(await createSecretToolStore(run).load(), LOGIN);
    assert.deepEqual(calls[0].args, ["lookup", "service", "milltime"]);
  });

  it("loads nothing when no item exists", async () => {
    const { run } = fakeRunner({ code: 1 });
    assert.equal(await createSecretToolStore(run).load(), null);
  });

  it("reports keyring errors", async () => {
    const { run } = fakeRunner({ code: 1, stderr: "secret-tool: Cannot create an item in a locked collection" });
    await assert.rejects(createSecretToolStore(run).save(LOGIN), /locked collection/);
  });

  it("clears the item, also when it does not exist", async () => {
    const { run, calls } = fakeRunner({ code: 1 });

    await createSecretToolStore(run).clear();

    assert.deepEqual(calls[0].args, ["clear", "service", "milltime"]);
  });
});

describe("macOS keychain session store", () => {
  it("stores the login hex-encoded through stdin", async () => {
    const { run, calls } = fakeRunner({});

    await createMacosKeychainStore(run).save(LOGIN);

    assert.deepEqual(calls[0].args, ["-i"]);
    const hex = Buffer.from(JSON.stringify(LOGIN)).toString("hex");
    assert.equal(
      calls[0].input,
      `add-generic-password -U -s milltime -a milltime -l "Milltime session" -X ${hex}\n`,
    );
  });

  it("loads a stored login", async () => {
    const { run, calls } = fakeRunner({ stdout: `${JSON.stringify(LOGIN)}\n` });

    assert.deepEqual(await createMacosKeychainStore(run).load(), LOGIN);
    assert.deepEqual(calls[0].args, ["find-generic-password", "-s", "milltime", "-a", "milltime", "-w"]);
  });

  it("loads nothing and clears quietly when no item exists", async () => {
    const { run } = fakeRunner({ code: 44 }, { code: 44 });
    const store = createMacosKeychainStore(run);

    assert.equal(await store.load(), null);
    await store.clear();
  });
});

describe("selectSessionStore", () => {
  const base = { env: {}, homeDir: "/home/user", uid: 1000, fileExists: () => false };

  it("uses the macOS keychain on macOS", async () => {
    const { run } = fakeRunner();
    const { store, warning } = await selectSessionStore({ ...base, platform: "darwin", run });
    assert.equal(store.name, "macOS keychain");
    assert.equal(warning, undefined);
  });

  it("uses secret-tool on Linux when a secret service answers", async () => {
    const { run } = fakeRunner({ code: 1 });
    const { store, warning } = await selectSessionStore({ ...base, platform: "linux", run });
    assert.match(store.name, /secret-tool/);
    assert.equal(warning, undefined);
  });

  it("falls back to a file with a warning when secret-tool is missing or cannot connect", async () => {
    for (const probe of [{ code: null, stderr: "spawn secret-tool ENOENT" }, { code: 1, stderr: "Could not connect" }]) {
      const { run } = fakeRunner(probe);
      const { store, warning } = await selectSessionStore({ ...base, platform: "linux", run });
      assert.equal(store.name, "/home/user/.config/milltime/session.json");
      assert.match(warning!, /No keychain available/);
    }
  });

  it("explains a missing login when no keychain was reachable", async () => {
    const { run } = fakeRunner({ code: 1, stderr: "Could not connect" });
    const { missingLoginHint } = await selectSessionStore({ ...base, platform: "linux", run });
    assert.match(missingLoginHint!, /No keychain was reachable.*MILLTIME_CONFIG_DIR/);
  });

  it("gives secret-tool the user's standard session bus when the environment leaves it out", async () => {
    const { run, calls } = fakeRunner({ code: 1 }, { stdout: JSON.stringify(LOGIN) });
    const { store } = await selectSessionStore({
      ...base,
      env: { HOME: "/home/user" },
      fileExists: (path) => path === "/run/user/1000/bus",
      platform: "linux",
      run,
    });

    assert.deepEqual(await store.load(), LOGIN);
    const busEnv = { HOME: "/home/user", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" };
    assert.deepEqual(
      calls.map((call) => call.env),
      [busEnv, busEnv],
    );
  });

  it("finds the session bus in XDG_RUNTIME_DIR", async () => {
    const { run, calls } = fakeRunner({ code: 1 });
    await selectSessionStore({
      ...base,
      env: { XDG_RUNTIME_DIR: "/xdg-run" },
      fileExists: (path) => path === "/xdg-run/bus",
      platform: "linux",
      run,
    });
    assert.equal(calls[0].env?.DBUS_SESSION_BUS_ADDRESS, "unix:path=/xdg-run/bus");
  });

  it("leaves the environment alone when it has a session bus, or there is none to find", async () => {
    const cases = [
      { env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/custom" }, fileExists: () => true },
      { env: {}, fileExists: () => false },
    ];
    for (const { env, fileExists } of cases) {
      const { run, calls } = fakeRunner({ code: 1 });
      await selectSessionStore({ ...base, env, fileExists, platform: "linux", run });
      assert.equal(calls[0].env, undefined);
    }
  });

  it("uses MILLTIME_CONFIG_DIR as a file store without probing", async () => {
    const { run, calls } = fakeRunner();
    const { store, warning } = await selectSessionStore({
      ...base,
      env: { MILLTIME_CONFIG_DIR: "/tmp/milltime" },
      platform: "darwin",
      run,
    });
    assert.equal(store.name, "/tmp/milltime/session.json");
    assert.equal(warning, undefined);
    assert.equal(calls.length, 0);
  });

  it("finds the config directory", () => {
    assert.equal(configDir(base), "/home/user/.config/milltime");
    assert.equal(configDir({ ...base, env: { XDG_CONFIG_HOME: "/xdg" } }), "/xdg/milltime");
  });
});
