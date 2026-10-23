import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeMilltime, loadFixture, serveFixture } from "../support/fake-milltime.ts";
import { listProjects } from "../../src/endpoints/projects.ts";

describe("listProjects", () => {
  it("maps favorites to projects with typed activities", async () => {
    const server = new FakeMilltime([serveFixture(loadFixture("project-favorite"))]);

    const projects = await listProjects(server.createClient());
    const activities = projects.flatMap((p) => p.activities);

    assert.ok(projects.length > 0);
    assert.ok(activities.some((a) => a.timeType === "NORMALTIME"), "untyped work activities default to NORMALTIME");
    assert.ok(activities.some((a) => a.timeType === "TRAVELTIME1"));
    assert.ok(activities.some((a) => a.absenceType === "VACATION"));
    for (const project of projects) {
      assert.ok(project.activities.every((a) => a.project.id === project.id));
    }
  });
});
