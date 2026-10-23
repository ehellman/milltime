import { z } from "zod";
import { ApiResponseSchema, MilltimeApiError, MilltimeHttpError, MilltimeNotLoggedInError } from "./types.ts";
import type { ApiResponse } from "./types.ts";
import { readCookie, decodeJwtPayload } from "./cookies.ts";

/** Everything needed to resume a logged-in session without the password. */
export interface StoredSession {
  token: string;
  csrfToken: string;
  instanceCookie: string | null;
  userId: string;
  expiresAt: number; // epoch ms, from the cookie's Max-Age
}

/** Password auth logs in on demand; session auth never logs in and fails with MilltimeNotLoggedInError. */
export type MilltimeAuth =
  | { kind: "password"; username: string; password: string }
  | { kind: "session"; session: StoredSession };

export interface MilltimeClientConfig {
  baseUrl: string; // e.g. "https://example.millnet.cloud"
  instanceId: string; // e.g. "000123.1", from listInstances
  auth: MilltimeAuth;
  /** Called after login and whenever a response slides the session. */
  onSessionChange?: (session: StoredSession) => void;
  fetch?: typeof fetch;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string>;
}

const CGI_PATH = "/cgi/mt.cgi";
const INTERNAL_API_PATH = "/api/internal";
const SESSION_COOKIE = "milltimesessionid";
const INSTANCE_COOKIE = "milltimeinstanceid";
const CSRF_COOKIE = "CSRFToken";
// Server answers 403 {"errors":["User is NOT logged in"]} for a missing or expired session.
const AUTH_FAILURE_STATUS = 403;
// Login cookie carries Max-Age=28800; the JWT's own exp claim is 30 days and must not be trusted.
const DEFAULT_SESSION_SECONDS = 8 * 60 * 60;

export class MilltimeClient {
  private readonly config: MilltimeClientConfig;
  private readonly fetch: typeof fetch;
  private sessionToken: string | null = null;
  private instanceCookie: string | null = null;
  private csrfToken: string | null = null;
  private sessionExpiry = 0;
  private userId: string | null = null;
  private pendingLogin: Promise<void> | null = null;

  constructor(config: MilltimeClientConfig) {
    this.config = config;
    this.fetch = config.fetch ?? globalThis.fetch;
    if (config.auth.kind === "session") this.restoreSession(config.auth.session);
  }

  get session(): StoredSession {
    if (!this.sessionToken || !this.csrfToken || !this.userId) throw new MilltimeNotLoggedInError();
    return {
      token: this.sessionToken,
      csrfToken: this.csrfToken,
      instanceCookie: this.instanceCookie,
      userId: this.userId,
      expiresAt: this.sessionExpiry,
    };
  }

  get currentUserId(): string {
    if (!this.userId) throw new Error("Not logged in");
    return this.userId;
  }

  /** Logs in if needed and returns the current user's id. */
  async getUserId(): Promise<string> {
    await this.ensureSession();
    return this.currentUserId;
  }

  /** Logs in. Concurrent callers share one login instead of racing each other. */
  login(): Promise<void> {
    if (this.config.auth.kind === "session") return Promise.reject(new MilltimeNotLoggedInError());
    this.pendingLogin ??= this.performLogin().finally(() => {
      this.pendingLogin = null;
    });
    return this.pendingLogin;
  }

  private async performLogin(): Promise<void> {
    const { username, password } = this.config.auth as Extract<MilltimeAuth, { kind: "password" }>;
    this.csrfToken = await this.fetchCsrfToken();

    const form = new FormData();
    form.append("userlogin", username);
    form.append("password", password);
    form.append("instanceid", this.config.instanceId);

    const response = await this.fetch(`${this.config.baseUrl}${CGI_PATH}/api/login`, {
      method: "POST",
      headers: { Cookie: `${CSRF_COOKIE}=${this.csrfToken}`, "X-CSRF-Token": this.csrfToken },
      body: form,
    });
    await parseEnvelope(response);

    const cookies = response.headers.getSetCookie();
    if (!readCookie(cookies, SESSION_COOKIE)) {
      throw new Error(`No ${SESSION_COOKIE} cookie in login response`);
    }
    this.storeSessionCookies(cookies);
    this.instanceCookie = readCookie(cookies, INSTANCE_COOKIE)?.value ?? null;

    const payload = decodeJwtPayload(this.sessionToken!);
    this.userId = typeof payload.userid === "string" ? payload.userid : null;
    if (!this.userId) throw new Error("Session token has no userid claim");
    this.notifySessionChange();
  }

  /** Ends the session on the server, so a copy of the token stops working too. */
  async logout(): Promise<void> {
    await this.request("DELETE", "/api/logout");
    this.sessionToken = null;
    this.sessionExpiry = 0;
  }

  /** Calls a /cgi/mt.cgi endpoint and unwraps the {success, rows} envelope. */
  async request(method: string, path: string, options?: RequestOptions): Promise<ApiResponse> {
    const response = await this.send(method, `${CGI_PATH}${path}`, options);
    return parseEnvelope(response);
  }

  /** Calls an /api/internal endpoint, which returns bare JSON without an envelope. */
  async requestInternal(method: string, path: string, options?: RequestOptions): Promise<unknown> {
    const response = await this.send(method, `${INTERNAL_API_PATH}${path}`, options);
    if (!response.ok) throw new MilltimeHttpError(response.status, await response.text());
    return response.json();
  }

  private async send(method: string, path: string, options?: RequestOptions): Promise<Response> {
    await this.ensureSession();

    const response = await this.sendOnce(method, path, options);
    if (response.status !== AUTH_FAILURE_STATUS) return response;
    if (this.config.auth.kind === "session") throw new MilltimeNotLoggedInError();

    await this.login();
    return this.sendOnce(method, path, options);
  }

  private async ensureSession(): Promise<void> {
    if (this.hasValidSession()) return;
    if (this.config.auth.kind === "session") throw new MilltimeNotLoggedInError();
    await this.login();
  }

  private async sendOnce(method: string, path: string, options?: RequestOptions): Promise<Response> {
    const url = new URL(`${this.config.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options?.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      Cookie: this.cookieHeader(),
      "X-CSRF-Token": this.csrfToken!,
    };
    if (options?.body !== undefined) headers["Content-Type"] = "application/json";

    const response = await this.fetch(url, {
      method,
      headers,
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    // The server slides the session on every response by re-issuing the cookie.
    if (this.storeSessionCookies(response.headers.getSetCookie())) this.notifySessionChange();
    return response;
  }

  private async fetchCsrfToken(): Promise<string> {
    const response = await this.fetch(`${this.config.baseUrl}${CGI_PATH}/`);
    const token = readCookie(response.headers.getSetCookie(), CSRF_COOKIE);
    if (!token) throw new Error(`No ${CSRF_COOKIE} cookie from ${this.config.baseUrl}${CGI_PATH}/`);
    return token.value;
  }

  /** Returns whether the cookies carried a session. */
  private storeSessionCookies(cookies: string[]): boolean {
    const session = readCookie(cookies, SESSION_COOKIE);
    if (!session) return false;
    this.sessionToken = session.value;
    this.sessionExpiry = Date.now() + (session.maxAge ?? DEFAULT_SESSION_SECONDS) * 1000;
    return true;
  }

  private restoreSession(session: StoredSession): void {
    this.sessionToken = session.token;
    this.csrfToken = session.csrfToken;
    this.instanceCookie = session.instanceCookie;
    this.userId = session.userId;
    this.sessionExpiry = session.expiresAt;
  }

  private notifySessionChange(): void {
    this.config.onSessionChange?.(this.session);
  }

  private hasValidSession(): boolean {
    return this.sessionToken !== null && Date.now() < this.sessionExpiry;
  }

  private cookieHeader(): string {
    const parts = [`${SESSION_COOKIE}=${this.sessionToken}`, `${CSRF_COOKIE}=${this.csrfToken}`];
    if (this.instanceCookie) parts.push(`${INSTANCE_COOKIE}=${this.instanceCookie}`);
    return parts.join("; ");
  }
}

async function parseEnvelope(response: Response): Promise<ApiResponse> {
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new MilltimeHttpError(response.status, text);
  }
  const parsed = ApiResponseSchema.safeParse(json);
  if (!parsed.success) throw new MilltimeHttpError(response.status, text);
  if (!parsed.data.success) throw new MilltimeApiError(response.status, parsed.data);
  if (!response.ok) throw new MilltimeHttpError(response.status, text);
  return parsed.data;
}

const RawInstanceSchema = z
  .object({ InstanceId: z.string(), InstanceName: z.string(), Disabled: z.boolean(), UserCount: z.number() })
  .passthrough();

export interface MilltimeInstance {
  id: string;
  name: string;
  userCount: number;
}

/** The instances a host serves, asked before logging in like the web UI's login page. Disabled ones are left out. */
export async function listInstances(
  baseUrl: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<MilltimeInstance[]> {
  const response = await parseEnvelope(await fetchFn(`${baseUrl}${CGI_PATH}/api/getInstances`));
  return z
    .array(RawInstanceSchema)
    .parse(response.rows ?? [])
    .filter((raw) => !raw.Disabled)
    .map((raw) => ({ id: raw.InstanceId, name: raw.InstanceName, userCount: raw.UserCount }));
}
