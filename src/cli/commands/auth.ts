import { MilltimeClient, listInstances } from "../../client.ts";
import type { MilltimeInstance } from "../../client.ts";
import { MilltimeApiError, MilltimeNotLoggedInError } from "../../types.ts";
import type { CliContext } from "../context.ts";
import { UsageError } from "../errors.ts";
import { formatLocalTime, loadLogin, withSession } from "../session.ts";
import type { SavedLogin } from "../session-store/index.ts";
import type { Settings } from "../settings.ts";
import type { CommandGroup, CommandInput, CommandOutput } from "./registry.ts";

// Read-only endpoint used to ask the server whether it still accepts the session.
const SESSION_CHECK_PATH = "/data/store/Supportinfo";

const ADDRESS_QUESTION = "Milltime address, e.g. https://yourcompany.millnet.cloud";

/** Accepts "yourcompany.millnet.cloud" as well as a full URL. */
function normalizeBaseUrl(address: string): string {
  const url = address.trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(url) ? url : `https://${url}`;
}

async function chooseBaseUrl(values: CommandInput["values"], settings: Settings, ctx: CliContext): Promise<string> {
  const address =
    (values["base-url"] as string | undefined) ?? settings.baseUrl ?? (await ctx.prompt.line(ADDRESS_QUESTION));
  if (!address) throw new UsageError("A Milltime address is required.");
  return normalizeBaseUrl(address);
}

/** The flag, else the last one used on this host, else the host's only instance, else the user picks. */
async function chooseInstanceId(
  values: CommandInput["values"],
  settings: Settings,
  baseUrl: string,
  ctx: CliContext,
): Promise<string> {
  const flag = values["instance-id"] as string | undefined;
  if (flag) return flag;
  if (settings.baseUrl === baseUrl && settings.instanceId) return settings.instanceId;

  const instances = await listInstances(baseUrl, ctx.fetch);
  if (instances.length === 0) throw new Error(`${baseUrl} has no active Milltime instances.`);
  if (instances.length === 1) return instances[0].id;
  return pickInstance(instances, ctx);
}

/** Lists the instances, largest first, and asks for one by number. */
async function pickInstance(instances: MilltimeInstance[], ctx: CliContext): Promise<string> {
  const sorted = [...instances].sort((a, b) => b.userCount - a.userCount);
  ctx.stderr(sorted.map((instance, i) => `  ${i + 1}. ${instance.name} (${instance.id})`).join("\n"));
  const answer = await ctx.prompt.line(`Instance (1-${sorted.length})`, "1");
  const chosen = sorted[Number(answer) - 1];
  if (!chosen) throw new UsageError(`No instance number ${answer}; pass --instance-id to pick one directly.`);
  return chosen.id;
}

async function login({ values }: CommandInput, ctx: CliContext): Promise<CommandOutput> {
  const settings = await ctx.settings.load();
  const baseUrl = await chooseBaseUrl(values, settings, ctx);
  const instanceId = await chooseInstanceId(values, settings, baseUrl, ctx);
  const username = (values.username as string | undefined) ?? (await ctx.prompt.line("Username", settings.username));
  if (!username) throw new UsageError("A username is required.");
  const password = (values.password as string | undefined) ?? (await ctx.prompt.password("Password"));
  if (!password) throw new UsageError("A password is required.");

  const client = new MilltimeClient({
    baseUrl,
    instanceId,
    auth: { kind: "password", username, password },
    fetch: ctx.fetch,
  });
  await loginOrExplain(client);

  const { store, warning } = await ctx.sessionStore();
  const saved: SavedLogin = { baseUrl, instanceId, username, session: client.session };
  await store.save(saved);
  await ctx.settings.save({ baseUrl, instanceId, username });
  if (warning) ctx.stderr(`Warning: ${warning}`);

  return {
    data: describeLogin(saved, store.name),
    text: [`Logged in as ${loginLine(saved)}.`, `Session stored in ${store.name}; ${expiryLine(saved)}.`].join("\n"),
  };
}

/** Turns the server's rejection into a plain message, e.g. "Login failed: Bad username or password". */
async function loginOrExplain(client: MilltimeClient): Promise<void> {
  try {
    await client.login();
  } catch (error) {
    if (error instanceof MilltimeApiError && error.response.errors?.length) {
      throw new Error(`Login failed: ${error.response.errors.join("; ")}`);
    }
    throw error;
  }
}

async function status({ values }: CommandInput, ctx: CliContext): Promise<CommandOutput> {
  if (values.check) await withSession(ctx, (client) => client.request("GET", SESSION_CHECK_PATH));
  const saved = await loadLogin(ctx);
  const { store } = await ctx.sessionStore();

  const lines = [`Logged in as ${loginLine(saved)}.`, `Session ${expiryLine(saved)} (stored in ${store.name}).`];
  if (values.check) lines.push("The server accepted the session.");
  return { data: { ...describeLogin(saved, store.name), checked: Boolean(values.check) }, text: lines.join("\n") };
}

async function logout(_input: CommandInput, ctx: CliContext): Promise<CommandOutput> {
  const endedOnServer = await endServerSession(ctx);
  const { store } = await ctx.sessionStore();
  await store.clear();
  const serverLine = endedOnServer ? "Ended the session on the server" : "No active session on the server";
  return {
    data: { loggedIn: false, endedOnServer },
    text: `${serverLine}; removed it from ${store.name}.`,
  };
}

/** Returns false when there was no session left to end. */
async function endServerSession(ctx: CliContext): Promise<boolean> {
  try {
    await withSession(ctx, (client) => client.logout());
    return true;
  } catch (error) {
    if (error instanceof MilltimeNotLoggedInError) return false;
    throw error;
  }
}

/** Everything about the login except the tokens. */
function describeLogin(saved: SavedLogin, storeName: string) {
  return {
    loggedIn: true,
    username: saved.username,
    userId: saved.session.userId,
    baseUrl: saved.baseUrl,
    instanceId: saved.instanceId,
    expiresAt: new Date(saved.session.expiresAt).toISOString(),
    store: storeName,
  };
}

function loginLine(saved: SavedLogin): string {
  return `${saved.username} (user ${saved.session.userId}) on ${saved.baseUrl}`;
}

function expiryLine(saved: SavedLogin): string {
  return `valid until ${formatLocalTime(saved.session.expiresAt)}, extended by each command`;
}

export const auth: CommandGroup = {
  summary: "Log in to Milltime and manage the stored session. The password is never stored.",
  commands: {
    login: {
      summary: "Log in and store the session",
      details: [
        "Options:",
        "  --username <name>    Milltime username (prompted if omitted; defaults to the last one used)",
        "  --password <secret>  Password (prompted without echo if omitted; visible in shell history if passed)",
        "  --base-url <url>     Milltime address, e.g. https://yourcompany.millnet.cloud (prompted if omitted;",
        "                       defaults to the last one used)",
        "  --instance-id <id>   Instance id (default: the last one used on this address, else asked from the server)",
      ].join("\n"),
      options: {
        username: { type: "string" },
        password: { type: "string" },
        "base-url": { type: "string" },
        "instance-id": { type: "string" },
      },
      run: login,
    },
    status: {
      summary: "Show who is logged in and when the session expires",
      details: "Options:\n  --check  Ask the server whether it still accepts the session (read-only)",
      options: { check: { type: "boolean" } },
      run: status,
    },
    logout: {
      summary: "End the session on the server and remove it locally",
      run: logout,
    },
  },
};
