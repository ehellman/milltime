// The MCP server over stdio against the real Milltime instance: logs the CLI in with .env credentials
// into a temporary config directory, starts `milltime-mcp` on it, calls read tools, then logs out. Read-only.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const CLI = new URL("../../src/bin.ts", import.meta.url).pathname;
const run = promisify(execFile);

let configDir: string;
let client: Client;

async function milltime(...args: string[]): Promise<void> {
  await run(process.execPath, [CLI, ...args], { env: { ...process.env, MILLTIME_CONFIG_DIR: configDir } });
}

async function callJson(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  assert.equal(result.isError, undefined, text);
  return JSON.parse(text);
}

describe("milltime MCP server", () => {
  before(async () => {
    const { MILLTIME_BASE_URL, MILLTIME_USER, MILLTIME_PASS, MILLTIME_INSTANCE_ID } = process.env;
    if (!MILLTIME_BASE_URL || !MILLTIME_USER || !MILLTIME_PASS || !MILLTIME_INSTANCE_ID) {
      throw new Error("Set MILLTIME_BASE_URL, MILLTIME_USER, MILLTIME_PASS and MILLTIME_INSTANCE_ID in .env");
    }
    configDir = await mkdtemp(join(tmpdir(), "milltime-live-"));
    // prettier-ignore
    await milltime(
      "auth", "login",
      "--username", MILLTIME_USER,
      "--password", MILLTIME_PASS,
      "--base-url", MILLTIME_BASE_URL,
      "--instance-id", MILLTIME_INSTANCE_ID,
    );
    client = new Client({ name: "live-test", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [CLI, "mcp"],
        env: { PATH: process.env.PATH ?? "", MILLTIME_CONFIG_DIR: configDir },
      }),
    );
  });

  after(async () => {
    await client?.close();
    await milltime("auth", "logout");
    await rm(configDir, { recursive: true, force: true });
  });

  it("serves the current week on the CLI's saved login", async () => {
    const week = await callJson("get_week");
    assert.equal(week.days.length, 7);
  });

  it("lists projects, allowances and reference data", async () => {
    assert.ok((await callJson("list_projects")).length > 0);
    assert.ok(Array.isArray(await callJson("list_allowances")));
    assert.ok((await callJson("list_countries")).some((c: any) => c.isDefault));
    assert.ok((await callJson("list_allowance_projects")).length > 0);
  });
});
