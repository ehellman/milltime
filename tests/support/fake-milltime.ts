// In-memory stand-in for the Milltime server, driven by JSON fixtures.
import { readFileSync } from "node:fs";
import { MilltimeClient } from "../../src/client.ts";
import type { MilltimeAuth, StoredSession } from "../../src/client.ts";

export interface Fixture {
  method: string;
  path: string;
  query: Record<string, unknown>;
  requestBody: unknown;
  status: number;
  responseBody: unknown;
}

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

export type Handler = (request: RecordedRequest) => Response | undefined;

export const TEST_USER_ID = "1";
export const TEST_INSTANCE_ID = "000123.1";

export interface FakeInstance {
  InstanceId: string;
  InstanceName: string;
  UserCount: number;
  Disabled?: boolean;
}
const SESSION_MAX_AGE = 28800;

export function storedSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    token: fakeJwt({ userid: TEST_USER_ID, stored: true }),
    csrfToken: "stored-csrf",
    instanceCookie: TEST_INSTANCE_ID,
    userId: TEST_USER_ID,
    expiresAt: Date.now() + SESSION_MAX_AGE * 1000,
    ...overrides,
  };
}

export function loadFixture(name: string): Fixture {
  const url = new URL(`../fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf-8")) as Fixture;
}

export function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

export function jsonResponse(body: unknown, status = 200, setCookies: string[] = []): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const cookie of setCookies) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

export function fixtureResponse(fixture: Fixture): Response {
  return jsonResponse(fixture.responseBody, fixture.status);
}

/** Answers with the fixture when method and path match. */
export function serveFixture(fixture: Fixture): Handler {
  return (request) =>
    request.method === fixture.method && request.url.pathname === fixture.path
      ? fixtureResponse(fixture)
      : undefined;
}

export class FakeMilltime {
  readonly requests: RecordedRequest[] = [];
  loginCount = 0;
  private readonly handlers: Handler[];
  private readonly userId: string;
  private readonly loginResponse?: () => Response;
  private readonly instances: FakeInstance[];

  /** `loginResponse` replaces the successful login, e.g. to reject the password. */
  constructor(
    handlers: Handler[] = [],
    options: { userId?: string; loginResponse?: () => Response; instances?: FakeInstance[] } = {},
  ) {
    this.handlers = handlers;
    this.userId = options.userId ?? TEST_USER_ID;
    this.loginResponse = options.loginResponse;
    this.instances = options.instances ?? [{ InstanceId: TEST_INSTANCE_ID, InstanceName: "Company", UserCount: 10 }];
  }

  createClient(
    auth: MilltimeAuth = { kind: "password", username: "user", password: "secret" },
    onSessionChange?: (session: StoredSession) => void,
  ): MilltimeClient {
    return new MilltimeClient({
      baseUrl: "https://milltime.test",
      instanceId: TEST_INSTANCE_ID,
      auth,
      onSessionChange,
      fetch: this.fetch,
    });
  }

  /** Requests other than the CSRF bootstrap and login. */
  get apiRequests(): RecordedRequest[] {
    return this.requests.filter(
      (r) => r.url.pathname !== "/cgi/mt.cgi/" && !r.url.pathname.endsWith("/api/login"),
    );
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const request = await record(input, init);
    this.requests.push(request);

    if (request.url.pathname === "/cgi/mt.cgi/") {
      return new Response("<html/>", {
        headers: { "Set-Cookie": "CSRFToken=csrf-token; Version=1; Path=/; Secure" },
      });
    }
    if (request.url.pathname.endsWith("/api/login")) return this.login();
    if (request.url.pathname.endsWith("/api/getInstances")) {
      return jsonResponse({ rows: this.instances.map((i) => ({ Disabled: false, ...i })), success: true });
    }

    for (const handler of this.handlers) {
      const response = handler(request);
      if (response) return response;
    }
    throw new Error(`Unhandled request: ${request.method} ${request.url}`);
  };

  private login(): Response {
    this.loginCount += 1;
    if (this.loginResponse) return this.loginResponse();
    const token = fakeJwt({ userid: this.userId, session: this.loginCount });
    return jsonResponse({ rows: [{ Sid: token, InstanceId: TEST_INSTANCE_ID }], success: true }, 200, [
      `milltimesessionid=${token}; Path=/; SameSite=Lax; Secure; Max-Age=${SESSION_MAX_AGE}`,
      `milltimeinstanceid=${TEST_INSTANCE_ID}; Path=/; SameSite=Lax; Max-Age=31536000`,
    ]);
  }
}

async function record(input: RequestInfo | URL, init?: RequestInit): Promise<RecordedRequest> {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  return { method: init?.method ?? "GET", url, headers, body: await readBody(init?.body) };
}

async function readBody(body: BodyInit | null | undefined): Promise<unknown> {
  if (body === undefined || body === null) return undefined;
  if (body instanceof FormData) return Object.fromEntries(body.entries());
  if (typeof body === "string") return JSON.parse(body);
  throw new Error("Unsupported body type in fake fetch");
}

export function filterOf(request: RecordedRequest): unknown {
  const filter = request.url.searchParams.get("filter");
  return filter === null ? undefined : JSON.parse(filter);
}

export function rowsOf(fixture: Fixture): any[] {
  return (fixture.responseBody as { rows: any[] }).rows;
}
