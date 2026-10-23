import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { withSession } from "../cli/session.ts";
import { processEnvironment, selectSessionStore } from "../cli/session-store/index.ts";
import type { SessionStoreSelection } from "../cli/session-store/index.ts";
import { localToday } from "../dates.ts";
import type { McpContext } from "./context.ts";
import { createServer } from "./server.ts";

function readVersion(): string {
  return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
}

/** Uses the login saved by "milltime auth login", and saves the session back when the server extends it. */
function createProcessContext(): McpContext {
  const environment = processEnvironment();
  let selection: Promise<SessionStoreSelection> | undefined;
  const session = { sessionStore: () => (selection ??= selectSessionStore(environment)), fetch: globalThis.fetch };
  return {
    withClient: (fn) => withSession(session, fn),
    today: localToday,
    secret: randomBytes(32),
    version: readVersion(),
  };
}

/** Serves the MCP tools over stdin and stdout until the client disconnects. */
export async function runMcpServer(): Promise<void> {
  await createServer(createProcessContext()).connect(new StdioServerTransport());
}
