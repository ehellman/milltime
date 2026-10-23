import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MilltimeClient } from "../../src/client.ts";
import type { McpContext } from "../../src/mcp/context.ts";
import { createServer } from "../../src/mcp/server.ts";
import { FakeMilltime, loadFixture, serveFixture } from "./fake-milltime.ts";
import type { Handler } from "./fake-milltime.ts";

export const TEST_SECRET = new Uint8Array(32).fill(7);

export interface ConnectedMcp {
  client: Client;
  server: FakeMilltime;
  call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
}

/** A real MCP client talking to the server over an in-memory transport, backed by FakeMilltime. */
export async function connectMcp(
  handlers: Handler[],
  options: { withClient?: McpContext["withClient"]; today?: string } = {},
): Promise<ConnectedMcp> {
  const server = new FakeMilltime(handlers);
  const withClient =
    options.withClient ?? (<T>(fn: (client: MilltimeClient) => Promise<T>) => fn(server.createClient()));
  const mcp = createServer({
    withClient,
    today: () => options.today ?? "2026-10-23",
    secret: TEST_SECRET,
    version: "test",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "test" });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
  return { client, server, call };
}

export function fixtures(...names: string[]): Handler[] {
  return names.map((name) => serveFixture(loadFixture(name)));
}

export function textOf(result: CallToolResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

export function jsonOf(result: CallToolResult): any {
  if (result.isError) throw new Error(`Tool error: ${textOf(result)}`);
  return JSON.parse(textOf(result));
}
