import type { MilltimeClient } from "../client.ts";

/** Everything a tool touches outside its arguments, injectable for tests. */
export interface McpContext {
  /** Runs `fn` with a logged-in client; throws MilltimeNotLoggedInError without a saved login. */
  withClient: <T>(fn: (client: MilltimeClient) => Promise<T>) => Promise<T>;
  /** Today as "YYYY-MM-DD" in local time. */
  today: () => string;
  /** Key for confirm tokens; random per process, so a token never outlives the server. */
  secret: Uint8Array;
  version: string;
}
