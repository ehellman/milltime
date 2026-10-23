import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../src/cli/main.ts";
import { FakeMilltime, TEST_INSTANCE_ID, TEST_USER_ID, fakeJwt, jsonResponse, storedSession } from "../../support/fake-milltime.ts";
import type { RecordedRequest } from "../../support/fake-milltime.ts";
import { captureCli, savedLogin } from "../../support/cli.ts";
import type { CaptureOptions } from "../../support/cli.ts";

const HOST = "https://milltime.test";
const LOGIN = ["auth", "login", "--base-url", HOST];
const ADDRESS_QUESTION = "Milltime address, e.g. https://yourcompany.millnet.cloud";

const NOT_LOGGED_IN = { rows: [], errors: ["User is NOT logged in"], success: false };

async function run(options: CaptureOptions, ...argv: string[]) {
  const cli = captureCli(options);
  const code = await main(argv, cli.ctx);
  return { ...cli, code, out: cli.stdout.join("\n"), err: cli.stderr.join("\n") };
}

function supportinfo(response: () => Response) {
  return (request: RecordedRequest) => (request.url.pathname.endsWith("/Supportinfo") ? response() : undefined);
}

describe("auth login", () => {
  it("logs in with flags and stores the session, never the password", async () => {
    const server = new FakeMilltime();
    const result = await run({ server }, ...LOGIN, "--username", "user", "--password", "hunter2");

    assert.equal(result.code, 0);
    assert.equal(server.loginCount, 1);
    assert.deepEqual(result.prompt.questions, []);
    assert.equal(result.store.saved!.username, "user");
    assert.equal(result.store.saved!.session.userId, TEST_USER_ID);
    assert.doesNotMatch(JSON.stringify(result.store.saved), /hunter2/);
    assert.doesNotMatch(JSON.stringify(result.settings.settings), /hunter2/);
    assert.match(result.out, /Logged in as user \(user 1\) on https:\/\/milltime\.test/);
  });

  it("prompts for a missing address, username and password, and asks the server for the instance", async () => {
    const result = await run({ answers: ["milltime.test/", "user", "hunter2"] }, "auth", "login");

    assert.equal(result.code, 0);
    assert.deepEqual(result.prompt.questions, [ADDRESS_QUESTION, "Username", "Password"]);
    assert.equal(result.store.saved!.username, "user");
    assert.equal(result.store.saved!.baseUrl, "https://milltime.test");
    assert.equal(result.store.saved!.instanceId, TEST_INSTANCE_ID);
  });

  it("prompts only for the password when the username is given", async () => {
    const result = await run({ answers: ["hunter2"] }, ...LOGIN, "--username", "user");
    assert.deepEqual(result.prompt.questions, ["Password"]);
  });

  it("offers the last username and remembers host and instance", async () => {
    const first = await run({}, "auth", "login", "--username", "user", "--password", "x", "--base-url", "https://milltime.test", "--instance-id", "42");
    assert.deepEqual(first.settings.settings, { baseUrl: "https://milltime.test", instanceId: "42", username: "user" });

    const cli = captureCli({ answers: ["", "x"] });
    cli.settings.settings = first.settings.settings;
    assert.equal(await main(["auth", "login"], cli.ctx), 0);
    assert.deepEqual(cli.prompt.questions, ["Username [user]", "Password"]);
    assert.equal(cli.store.saved!.baseUrl, "https://milltime.test");
    assert.equal(cli.store.saved!.instanceId, "42");
  });

  it("asks which instance when the address has several, largest first", async () => {
    const server = new FakeMilltime([], {
      instances: [
        { InstanceId: "1.2", InstanceName: "Company test", UserCount: 5 },
        { InstanceId: "1.1", InstanceName: "Company", UserCount: 50 },
        { InstanceId: "1.3", InstanceName: "Old company", UserCount: 1, Disabled: true },
      ],
    });
    const result = await run({ server, answers: ["2"] }, ...LOGIN, "--username", "user", "--password", "x");

    assert.equal(result.code, 0);
    assert.deepEqual(result.prompt.questions, ["Instance (1-2) [1]"]);
    assert.equal(result.err, "  1. Company (1.1)\n  2. Company test (1.2)");
    assert.equal(result.store.saved!.instanceId, "1.2");
  });

  it("asks the server again when the address changes", async () => {
    const cli = captureCli();
    cli.settings.settings = { baseUrl: "https://other.test", instanceId: "42", username: "user" };

    assert.equal(await main([...LOGIN, "--username", "user", "--password", "x"], cli.ctx), 0);
    assert.equal(cli.store.saved!.instanceId, TEST_INSTANCE_ID);
  });

  it("explains a rejected login", async () => {
    const server = new FakeMilltime([], {
      loginResponse: () => jsonResponse({ rows: [], errors: ["Bad username or password"], success: false }, 403),
    });
    const result = await run({ server }, ...LOGIN, "--username", "user", "--password", "wrong");

    assert.equal(result.code, 1);
    assert.equal(result.err, "Error: Login failed: Bad username or password");
    assert.equal(result.store.saved, null);
  });

  it("refuses an empty password", async () => {
    const result = await run({ answers: [""] }, ...LOGIN, "--username", "user");
    assert.equal(result.code, 2);
    assert.equal(result.store.saved, null);
  });

  it("warns when the session falls back to a file", async () => {
    const result = await run({ storeWarning: "No keychain available" }, ...LOGIN, "--username", "e", "--password", "x");
    assert.equal(result.code, 0);
    assert.match(result.err, /Warning: No keychain available/);
  });

  it("prints the login without tokens as JSON", async () => {
    const result = await run({}, ...LOGIN, "--username", "user", "--password", "x", "--json");
    const data = JSON.parse(result.out);
    assert.equal(data.loggedIn, true);
    assert.equal(data.userId, TEST_USER_ID);
    assert.equal(data.store, "test keychain");
    assert.doesNotMatch(result.out, new RegExp(result.store.saved!.session.token));
  });
});

describe("auth status", () => {
  it("shows the stored login without contacting the server", async () => {
    const server = new FakeMilltime();
    const result = await run({ server, login: savedLogin() }, "auth", "status");

    assert.equal(result.code, 0);
    assert.equal(server.requests.length, 0);
    assert.match(result.out, /Logged in as user \(user 1\) on https:\/\/milltime\.test/);
    assert.match(result.out, /valid until \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  });

  it("exits 3 when not logged in or the session has expired", async () => {
    for (const login of [undefined, savedLogin({ session: storedSession({ expiresAt: Date.now() - 1 }) })]) {
      const result = await run({ login }, "auth", "status");
      assert.equal(result.code, 3);
      assert.equal(result.err, 'Not logged in. Run "milltime auth login".');
    }
  });

  it("checks the session with the server and saves the extended session", async () => {
    const extended = fakeJwt({ userid: TEST_USER_ID, extended: true });
    const server = new FakeMilltime([
      supportinfo(() => jsonResponse({ rows: [], success: true }, 200, [`milltimesessionid=${extended}; Max-Age=28800`])),
    ]);
    const result = await run({ server, login: savedLogin() }, "auth", "status", "--check");

    assert.equal(result.code, 0);
    assert.equal(server.loginCount, 0);
    assert.match(result.out, /The server accepted the session/);
    assert.equal(result.store.saved!.session.token, extended);
  });

  it("exits 3 when the server rejects the session", async () => {
    const server = new FakeMilltime([supportinfo(() => jsonResponse(NOT_LOGGED_IN, 403))]);
    const result = await run({ server, login: savedLogin() }, "auth", "status", "--check");

    assert.equal(result.code, 3);
    assert.equal(server.loginCount, 0);
  });
});

describe("auth logout", () => {
  const logoutEndpoint = (response: () => Response) => (request: RecordedRequest) =>
    request.method === "DELETE" && request.url.pathname.endsWith("/api/logout") ? response() : undefined;

  it("ends the session on the server and removes it locally", async () => {
    const server = new FakeMilltime([logoutEndpoint(() => jsonResponse({ rows: [], success: true }))]);
    const result = await run({ server, login: savedLogin() }, "auth", "logout");

    assert.equal(result.code, 0);
    assert.equal(server.apiRequests.length, 1);
    assert.equal(server.apiRequests[0].headers["x-csrf-token"], "stored-csrf");
    assert.equal(result.store.saved, null);
    assert.match(result.out, /^Ended the session on the server; removed it from test keychain\.$/);
  });

  it("removes an expired or rejected session without failing", async () => {
    const rejecting = new FakeMilltime([logoutEndpoint(() => jsonResponse(NOT_LOGGED_IN, 403))]);
    const expired = savedLogin({ session: storedSession({ expiresAt: Date.now() - 1 }) });

    for (const [server, login] of [[rejecting, savedLogin()], [new FakeMilltime(), expired]] as const) {
      const result = await run({ server, login }, "auth", "logout", "--json");
      assert.equal(result.code, 0);
      assert.deepEqual(JSON.parse(result.out), { loggedIn: false, endedOnServer: false });
      assert.equal(result.store.saved, null);
    }
  });

  it("succeeds when not logged in", async () => {
    const result = await run({}, "auth", "logout");
    assert.equal(result.code, 0);
    assert.match(result.out, /No active session on the server/);
  });
});
