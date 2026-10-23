import { MilltimeClient } from "../client.ts";
import type { StoredSession } from "../client.ts";
import { MilltimeNotLoggedInError } from "../types.ts";
import type { CliContext } from "./context.ts";
import type { SavedLogin } from "./session-store/index.ts";

/** Loads the saved login, or throws MilltimeNotLoggedInError when there is none or it has expired. */
export async function loadLogin(ctx: Pick<CliContext, "sessionStore">): Promise<SavedLogin> {
  const { store } = await ctx.sessionStore();
  const login = await store.load();
  if (!login || login.session.expiresAt <= Date.now()) throw new MilltimeNotLoggedInError();
  return login;
}

/** Runs `fn` with a client on the saved session, and saves the session if the server extended it. */
export async function withSession<T>(
  ctx: Pick<CliContext, "sessionStore" | "fetch">,
  fn: (client: MilltimeClient) => Promise<T>,
): Promise<T> {
  const login = await loadLogin(ctx);
  let extended: StoredSession | null = null;
  const client = new MilltimeClient({
    baseUrl: login.baseUrl,
    instanceId: login.instanceId,
    auth: { kind: "session", session: login.session },
    onSessionChange: (session) => (extended = session),
    fetch: ctx.fetch,
  });

  const result = await fn(client);
  if (extended) {
    const { store } = await ctx.sessionStore();
    await store.save({ ...login, session: extended });
  }
  return result;
}

/** Local "YYYY-MM-DD HH:MM". */
export function formatLocalTime(epochMs: number): string {
  const date = new Date(epochMs);
  return new Date(epochMs - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16).replace("T", " ");
}
