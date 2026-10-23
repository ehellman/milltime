import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FakeMilltime,
  TEST_USER_ID,
  fakeJwt,
  jsonResponse,
  loadFixture,
  serveFixture,
  storedSession,
} from "../support/fake-milltime.ts";
import { MilltimeApiError, MilltimeNotLoggedInError } from "../../src/types.ts";
import type { StoredSession } from "../../src/client.ts";

const NOT_LOGGED_IN = { rows: [], errors: ["User is NOT logged in"], success: false };

describe("MilltimeClient", () => {
  it("logs in with CSRF token and form credentials", async () => {
    const server = new FakeMilltime();
    const client = server.createClient();

    await client.login();

    const login = server.requests.find((r) => r.url.pathname.endsWith("/api/login"))!;
    assert.equal(login.headers["x-csrf-token"], "csrf-token");
    assert.equal(login.headers.cookie, "CSRFToken=csrf-token");
    assert.deepEqual(login.body, { userlogin: "user", password: "secret", instanceid: "000123.1" });
    assert.equal(client.currentUserId, TEST_USER_ID);
  });

  it("logs in lazily and sends session cookies and CSRF header", async () => {
    const server = new FakeMilltime([serveFixture(loadFixture("currency"))]);
    const client = server.createClient();

    const response = await client.request("GET", "/data/store/Currency");

    assert.ok(response.rows!.length > 0);
    const [request] = server.apiRequests;
    assert.equal(request.headers["x-csrf-token"], "csrf-token");
    assert.match(request.headers.cookie, /milltimesessionid=[^;]+/);
    assert.match(request.headers.cookie, /CSRFToken=csrf-token/);
    assert.match(request.headers.cookie, /milltimeinstanceid=000123\.1/);
  });

  it("reuses the session across requests", async () => {
    const server = new FakeMilltime([serveFixture(loadFixture("currency"))]);
    const client = server.createClient();

    await client.request("GET", "/data/store/Currency");
    await client.request("GET", "/data/store/Currency");

    assert.equal(server.loginCount, 1);
  });

  it("re-logs in and retries once when the session is rejected", async () => {
    let rejectNext = false;
    const server = new FakeMilltime([
      () => (rejectNext ? ((rejectNext = false), jsonResponse(NOT_LOGGED_IN, 403)) : undefined),
      serveFixture(loadFixture("currency")),
    ]);
    const client = server.createClient();
    await client.login();
    rejectNext = true;

    await client.request("GET", "/data/store/Currency");

    assert.equal(server.loginCount, 2);
    assert.equal(server.apiRequests.length, 2);
  });

  it("throws MilltimeApiError with server errors when retry is also rejected", async () => {
    const server = new FakeMilltime([() => jsonResponse(NOT_LOGGED_IN, 403)]);
    const client = server.createClient();

    await assert.rejects(client.request("GET", "/data/store/Currency"), (error: unknown) => {
      assert.ok(error instanceof MilltimeApiError);
      assert.equal(error.status, 403);
      assert.match(error.message, /User is NOT logged in/);
      return true;
    });
    assert.equal(server.loginCount, 2);
  });

  it("uses the re-issued session cookie from responses", async () => {
    const refreshed = fakeJwt({ userid: TEST_USER_ID, refreshed: true });
    const server = new FakeMilltime([
      (request) =>
        request.url.pathname.endsWith("/Currency")
          ? jsonResponse({ rows: [], success: true }, 200, [`milltimesessionid=${refreshed}; Max-Age=28800`])
          : undefined,
    ]);
    const client = server.createClient();

    await client.request("GET", "/data/store/Currency");
    await client.request("GET", "/data/store/Currency");

    assert.match(server.apiRequests[1].headers.cookie, new RegExp(`milltimesessionid=${refreshed}`));
  });

  it("returns bare JSON from /api/internal endpoints", async () => {
    const fixture = loadFixture("project-search-expense");
    const server = new FakeMilltime([serveFixture(fixture)]);
    const client = server.createClient();

    const result = await client.requestInternal("GET", "/project/search", {
      query: { view: "Expense", memberOnly: "true" },
    });

    assert.deepEqual(result, fixture.responseBody);
    assert.equal(server.apiRequests[0].url.search, "?view=Expense&memberOnly=true");
  });

  it("reports the session after login", async () => {
    const changes: StoredSession[] = [];
    const server = new FakeMilltime();
    const client = server.createClient(undefined, (session) => changes.push(session));

    await client.login();

    assert.equal(changes.length, 1);
    assert.deepEqual(changes[0], client.session);
    assert.equal(client.session.userId, TEST_USER_ID);
    assert.equal(client.session.csrfToken, "csrf-token");
    assert.equal(client.session.instanceCookie, "000123.1");
    assert.ok(client.session.expiresAt > Date.now());
  });

  it("reports the session when a response re-issues the cookie", async () => {
    const refreshed = fakeJwt({ userid: TEST_USER_ID, refreshed: true });
    const changes: StoredSession[] = [];
    const server = new FakeMilltime([
      () => jsonResponse({ rows: [], success: true }, 200, [`milltimesessionid=${refreshed}; Max-Age=28800`]),
    ]);
    const client = server.createClient({ kind: "session", session: storedSession() }, (s) => changes.push(s));

    await client.request("GET", "/data/store/Currency");

    assert.equal(changes.length, 1);
    assert.equal(changes[0].token, refreshed);
    assert.equal(changes[0].csrfToken, "stored-csrf");
  });
});

describe("MilltimeClient logout", () => {
  it("ends the session on the server and forgets it", async () => {
    const server = new FakeMilltime([
      (request) =>
        request.method === "DELETE" && request.url.pathname === "/cgi/mt.cgi/api/logout"
          ? jsonResponse({ rows: [], success: true })
          : undefined,
    ]);
    const client = server.createClient({ kind: "session", session: storedSession() });

    await client.logout();

    assert.equal(server.apiRequests.length, 1);
    assert.throws(() => client.session, MilltimeNotLoggedInError);
    await assert.rejects(client.request("GET", "/data/store/Currency"), MilltimeNotLoggedInError);
  });
});

describe("MilltimeClient with session auth", () => {
  it("sends the stored session without logging in", async () => {
    const session = storedSession();
    const server = new FakeMilltime([serveFixture(loadFixture("currency"))]);
    const client = server.createClient({ kind: "session", session });

    await client.request("GET", "/data/store/Currency");

    assert.equal(server.requests.length, 1);
    const [request] = server.apiRequests;
    assert.equal(request.headers["x-csrf-token"], "stored-csrf");
    assert.equal(
      request.headers.cookie,
      `milltimesessionid=${session.token}; CSRFToken=stored-csrf; milltimeinstanceid=000123.1`,
    );
    assert.equal(await client.getUserId(), TEST_USER_ID);
  });

  it("throws MilltimeNotLoggedInError without logging in when the session is rejected", async () => {
    const server = new FakeMilltime([() => jsonResponse(NOT_LOGGED_IN, 403)]);
    const client = server.createClient({ kind: "session", session: storedSession() });

    await assert.rejects(client.request("GET", "/data/store/Currency"), MilltimeNotLoggedInError);
    assert.equal(server.loginCount, 0);
  });

  it("throws MilltimeNotLoggedInError without a request when the session has expired", async () => {
    const server = new FakeMilltime();
    const client = server.createClient({ kind: "session", session: storedSession({ expiresAt: Date.now() - 1 }) });

    await assert.rejects(client.request("GET", "/data/store/Currency"), MilltimeNotLoggedInError);
    await assert.rejects(client.getUserId(), MilltimeNotLoggedInError);
    assert.equal(server.requests.length, 0);
  });

  it("refuses to log in", async () => {
    const server = new FakeMilltime();
    const client = server.createClient({ kind: "session", session: storedSession() });

    await assert.rejects(client.login(), MilltimeNotLoggedInError);
    assert.equal(server.requests.length, 0);
  });
});
