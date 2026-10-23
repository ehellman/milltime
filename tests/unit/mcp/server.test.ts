import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MilltimeNotLoggedInError } from "../../../src/types.ts";
import { filterOf } from "../../support/fake-milltime.ts";
import { connectMcp, fixtures, jsonOf, textOf } from "../../support/mcp.ts";

describe("mcp server", () => {
  it("marks read tools read-only", async () => {
    const { client } = await connectMcp([]);

    const { tools } = await client.listTools();

    const week = tools.find((tool) => tool.name === "get_week");
    assert.equal(week?.annotations?.readOnlyHint, true);
  });

  it("returns a week as JSON, defaulting to this week", async () => {
    const { call, server } = await connectMcp(fixtures("calendar-week-before-note", "time-info"), {
      today: "2026-10-08",
    });

    const week = jsonOf(await call("get_week"));

    assert.equal(week.from, "2026-10-05");
    assert.equal(week.days.length, 7);
    assert.deepEqual(filterOf(server.apiRequests[0]), [
      ["fromDate", "=", "2026-10-05"],
      ["toDate", "=", "2026-10-11"],
    ]);
  });

  it("lists projects with their activities", async () => {
    const { call } = await connectMcp(fixtures("project-favorite"));

    const projects = jsonOf(await call("list_projects"));

    assert.ok(projects[0].activities.length > 0);
    for (const activity of projects.flatMap((p: any) => p.activities)) {
      assert.equal(typeof activity.key, "string");
      assert.deepEqual(
        Object.keys(activity).filter((k) => ["id", "taskId", "project"].includes(k)),
        [],
      );
    }
  });

  it("tells the model how to log in when there is no saved login", async () => {
    const { call } = await connectMcp([], { withClient: async () => Promise.reject(new MilltimeNotLoggedInError()) });

    const result = await call("list_projects");

    assert.equal(result.isError, true);
    assert.match(textOf(result), /milltime auth login/);
  });

  it("passes on why the login may be missing", async () => {
    const error = new MilltimeNotLoggedInError("No keychain was reachable.");
    const { call } = await connectMcp([], { withClient: async () => Promise.reject(error) });

    assert.match(textOf(await call("list_projects")), /auth login.*\nNo keychain was reachable\.$/s);
  });

  it("rejects a malformed date before calling Milltime", async () => {
    const { call, server } = await connectMcp([]);

    const result = await call("get_week", { date: "23/10" });

    assert.equal(result.isError, true);
    assert.equal(server.apiRequests.length, 0);
  });
});
