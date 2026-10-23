// The installed CLI against the real Milltime instance: logs in with .env credentials into a
// temporary config directory, runs every read command, then logs out. Read-only.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const MAIN = new URL("../../src/bin.ts", import.meta.url).pathname;
const run = promisify(execFile);

let configDir: string;

async function milltime(...args: string[]): Promise<string> {
  const { stdout } = await run(process.execPath, [MAIN, ...args], {
    env: { ...process.env, MILLTIME_CONFIG_DIR: configDir },
  });
  return stdout;
}

async function milltimeJson(...args: string[]): Promise<any> {
  return JSON.parse(await milltime(...args, "--json"));
}

describe("milltime CLI", () => {
  before(async () => {
    const { MILLTIME_BASE_URL, MILLTIME_USER, MILLTIME_PASS, MILLTIME_INSTANCE_ID } = process.env;
    if (!MILLTIME_BASE_URL || !MILLTIME_USER || !MILLTIME_PASS || !MILLTIME_INSTANCE_ID) {
      throw new Error("Set MILLTIME_BASE_URL, MILLTIME_USER, MILLTIME_PASS and MILLTIME_INSTANCE_ID in .env");
    }
    configDir = await mkdtemp(join(tmpdir(), "milltime-live-"));
    await milltime(
      "auth", "login",
      "--username", MILLTIME_USER,
      "--password", MILLTIME_PASS,
      "--base-url", MILLTIME_BASE_URL,
      "--instance-id", MILLTIME_INSTANCE_ID,
    );
  });

  after(async () => {
    await milltime("auth", "logout");
    await rm(configDir, { recursive: true, force: true });
  });

  it("confirms the session with the server", async () => {
    const status = await milltimeJson("auth", "status", "--check");
    assert.equal(status.loggedIn, true);
    assert.equal(status.checked, true);
  });

  it("shows the current week", async () => {
    const week = await milltimeJson("time", "week");
    assert.equal(week.days.length, 7);
    assert.equal(week.scheduledHours <= 40, true);
  });

  it("shows the previous week's lock status", async () => {
    const status = await milltimeJson("lock", "status", "prev");
    assert.equal(typeof status.canLock, "boolean");
  });

  it("lists projects, expenses and reference data", async () => {
    assert.ok((await milltimeJson("time", "projects")).length > 0);
    assert.ok(Array.isArray(await milltimeJson("expenses", "list")));
    assert.ok((await milltimeJson("expenses", "types")).length > 0);
    assert.ok((await milltimeJson("expenses", "currencies")).some((c: any) => c.isHomeCurrency));
    assert.ok((await milltimeJson("expenses", "projects")).length > 0);
  });

  it("prints text output", async () => {
    assert.match(await milltime("time", "week"), /^Week \d+: /);
  });
});
