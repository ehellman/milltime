import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../src/cli/main.ts";
import { FakeMilltime, loadFixture, rowsOf, serveFixture } from "../../support/fake-milltime.ts";
import { captureCli, savedLogin } from "../../support/cli.ts";

const createBody = loadFixture("time-create").requestBody as Record<string, string>;
const calendarRows = rowsOf(loadFixture("calendar-week-before-note")).flatMap((m) =>
  m.weeks.flatMap((w: any) => w.days.flatMap((d: any) => d.projectregistrations)),
);
const unlockedRow = calendarRows.find((r) => (r.attestlevel ?? 0) < 1);

async function run(fixtures: string[], ...argv: string[]) {
  const server = new FakeMilltime(fixtures.map((name) => serveFixture(loadFixture(name))));
  const cli = captureCli({ server, login: savedLogin() });
  const code = await main(argv, cli.ctx);
  return { code, out: cli.stdout.join("\n"), err: cli.stderr.join("\n"), server };
}

function sentOnlyReads(server: FakeMilltime): boolean {
  return server.apiRequests.every((r) => r.method === "GET");
}

const ADD = ["time", "add", "2026-10-10", "--activity", createBody.planningtaskid, "--hours", "5"];
const ADD_FIXTURES = ["project-favorite", "calendar-week-before-note", "time-create"];

describe("time add", () => {
  it("reports time on the activity with that id", async () => {
    const { code, out, server } = await run(ADD_FIXTURES, ...ADD);

    assert.equal(code, 0);
    const post = server.apiRequests.find((r) => r.method === "POST") as { body: Record<string, unknown> };
    assert.equal(post.body.planningtaskid, createBody.planningtaskid);
    assert.equal(post.body.regday, "2026-10-10");
    assert.equal(post.body.inputtime, "5");
    assert.match(out, /^Reported 5h .* on 2026-10-10 \(row \d+\)$/);
  });

  it("shows the request without sending it with --dry-run", async () => {
    const { code, out, server } = await run(ADD_FIXTURES, ...ADD, "--dry-run");

    assert.equal(code, 0);
    assert.ok(sentOnlyReads(server));
    assert.match(out, /^Dry run, nothing sent: Report 5h .* on 2026-10-10\nPOST \/data\/store\/ProjectRegistrationReact\n\{/);
  });

  it("prints the plan as JSON with --dry-run --json", async () => {
    const { out } = await run(ADD_FIXTURES, ...ADD, "--dry-run", "--json");

    const plan = JSON.parse(out);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.method, "POST");
    assert.equal(plan.body.regday, "2026-10-10");
  });

  it("rejects an unknown activity id", async () => {
    const { code, err, server } = await run(ADD_FIXTURES, "time", "add", "today", "--activity", "nope", "--hours", "1");

    assert.equal(code, 2);
    assert.match(err, /No activity with id "nope"/);
    assert.ok(sentOnlyReads(server));
  });

  it("requires --hours above zero", async () => {
    for (const hours of [[], ["--hours", "0"], ["--hours", "x"]]) {
      const { code } = await run(ADD_FIXTURES, "time", "add", "today", "--activity", createBody.planningtaskid, ...hours);
      assert.equal(code, 2, `hours ${hours.join(" ")}`);
    }
  });
});

describe("time edit", () => {
  it("changes the hours of a row", async () => {
    const { code, out, server } = await run(
      ["calendar-week-before-note", "time-update-note"],
      "time", "edit", unlockedRow.regday, unlockedRow.projectregistrationid, "--hours", "1.5",
    );

    assert.equal(code, 0);
    const put = server.apiRequests.find((r) => r.method === "PUT") as { body: Record<string, unknown> };
    assert.equal(put.body.projtime, "1.50");
    assert.match(out, /^Updated row \d+: /);
  });

  it("refuses to edit without changes", async () => {
    const { code, err } = await run([], "time", "edit", "2026-10-05", "123");

    assert.equal(code, 2);
    assert.match(err, /Nothing to change/);
  });

  it("previews with --dry-run", async () => {
    const { code, out, server } = await run(
      ["calendar-week-before-note"],
      "time", "edit", unlockedRow.regday, unlockedRow.projectregistrationid, "--note", "hello", "--dry-run",
    );

    assert.equal(code, 0);
    assert.ok(sentOnlyReads(server));
    assert.match(out, /^Dry run, nothing sent: Update .*: note "hello"\nPUT /);
  });
});

describe("time delete", () => {
  const args = ["time", "delete", unlockedRow.regday, unlockedRow.projectregistrationid];

  it("deletes the row", async () => {
    const { code, out, server } = await run(["calendar-week-before-note", "time-delete"], ...args);

    assert.equal(code, 0);
    assert.equal(server.apiRequests.filter((r) => r.method === "DELETE").length, 1);
    assert.equal(out, `Deleted row ${unlockedRow.projectregistrationid} on ${unlockedRow.regday}`);
  });

  it("previews with --dry-run, without a body", async () => {
    const { out, server } = await run(["calendar-week-before-note"], ...args, "--dry-run");

    assert.ok(sentOnlyReads(server));
    assert.match(out, /^Dry run, nothing sent: Delete .*\nDELETE \/data\/store\/ProjectRegistrationReact\?filter=\[\["ProjectRegistrationId"/);
    assert.equal(out.split("\n").length, 2);
  });
});
