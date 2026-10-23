// The web UI sends local midnights; the fixtures are from Sweden.
process.env.TZ = "Europe/Stockholm";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../src/cli/main.ts";
import { FakeMilltime, loadFixture, serveFixture } from "../../support/fake-milltime.ts";
import type { Handler } from "../../support/fake-milltime.ts";
import { captureCli, savedLogin } from "../../support/cli.ts";

const createFixture = loadFixture("allowance-create-accommodation-meals");
const updateFixture = loadFixture("allowance-update");
const deleteFixture = loadFixture("allowance-delete");
const createBody = createFixture.requestBody as Record<string, any>;
const allowanceId = (updateFixture.query.filter as string[][])[0][2];
const REFERENCE = ["calendar-week-before-note", "country", "project-search-allowance"];

async function run(handlers: Handler[], ...argv: string[]) {
  const server = new FakeMilltime(handlers);
  const cli = captureCli({ server, login: savedLogin() });
  const code = await main(argv, cli.ctx);
  return { code, out: cli.stdout.join("\n"), err: cli.stderr.join("\n"), server };
}

function fixtures(...names: string[]): Handler[] {
  return names.map((name) => serveFixture(loadFixture(name)));
}

function withoutRegday(body: unknown): Record<string, unknown> {
  const { regday: _regday, ...rest } = body as Record<string, unknown>;
  return rest;
}

/** The trip in allowance-create-accommodation-meals.json. */
const ADD_ARGS = [
  "allowances", "add",
  "--from", "2026-10-19",
  "--to", "2026-10-22",
  "--departure", "after-noon",
  "--return", "after-7pm",
  "--destination", createBody.allowancedays[0].destination,
  "--purpose", createBody.purpose,
  "--project", createBody.projectid,
  "--breakfast", "paid-myself",
  "--lunch", "paid-myself",
  "--dinner", "paid-myself",
  "--private-accommodation", "no",
  "--day", "2026-10-20:accommodation=yes",
  "--day", "2026-10-21:breakfast=hotel,lunch=employer",
];

describe("allowances list", () => {
  it("shows each trip with its days", async () => {
    const { code, out } = await run(fixtures("allowance-list-accommodation-meals"), "allowances", "list", "2026-10");

    assert.equal(code, 0);
    assert.match(out, /2026-10-19 – 2026-10-22 to .*, id \d+/);
    assert.match(out, /Left after 12, back after 19\. Compensation 1035\.00\./);
    assert.match(out, /2026-10-20 +domestic +domestic +paid-myself/);
    assert.match(out, /2026-10-21 +domestic +hotel +employer +paid-myself/);
  });
});

describe("allowances add", () => {
  it("previews with --dry-run and sends nothing", async () => {
    const { code, out, server } = await run(fixtures(...REFERENCE), ...ADD_ARGS, "--dry-run", "--json");

    assert.equal(code, 0);
    assert.ok(server.apiRequests.every((r) => r.method === "GET"));
    const plan = JSON.parse(out);
    assert.equal(plan.dryRun, true);
    assert.deepEqual(withoutRegday(plan.body), withoutRegday(createBody));
  });

  it("adds the allowance and shows the compensation Milltime computed", async () => {
    const { code, out } = await run(fixtures(...REFERENCE, "allowance-create-accommodation-meals"), ...ADD_ARGS);

    assert.equal(code, 0);
    assert.match(out, /^Added allowance \d+\n/);
    assert.match(out, /Compensation 1035\.00/);
  });

  it("lists every missing option at once", async () => {
    const { code, err } = await run([], "allowances", "add", "--from", "2026-10-19", "--to", "2026-10-22");

    assert.equal(code, 2);
    assert.match(
      err,
      /Missing --departure, --return, --destination, --purpose, --project, --breakfast, --lunch, --dinner, --private-accommodation\./,
    );
  });

  for (const [args, message] of [
    [["--lunch", "hotel"], /Invalid --lunch "hotel"\. Use paid-myself, deduction, ticket, employer\./],
    [["--departure", "noon"], /Invalid --departure "noon"/],
    [["--day", "2026-10-20:snacks=yes"], /Invalid --day key/],
    [["--project", "123"], /No allowance project with id "123"/],
  ] as const) {
    it(`rejects ${args.join(" ")} without sending`, async () => {
      const { code, err, server } = await run(fixtures(...REFERENCE), ...ADD_ARGS, ...args);

      assert.equal(code, 2);
      assert.match(err, message);
      assert.ok(server.apiRequests.every((r) => r.method === "GET"));
    });
  }
});

describe("allowances edit", () => {
  it("changes one day's lunch like the web UI", async () => {
    const { code, server } = await run(
      fixtures(...REFERENCE, "allowance-list-before-update", "allowance-update"),
      "allowances", "edit", "2026-10-20", allowanceId, "--day", "2026-10-20:lunch=deduction",
    );

    assert.equal(code, 0);
    const put = server.apiRequests.find((r) => r.method === "PUT");
    assert.deepEqual(withoutRegday(put?.body), withoutRegday(updateFixture.requestBody));
  });

  it("needs something to change", async () => {
    const { code, err } = await run([], "allowances", "edit", "2026-10-20", allowanceId);

    assert.equal(code, 2);
    assert.match(err, /Nothing to change/);
  });
});

describe("allowances delete", () => {
  it("previews with --dry-run and sends nothing", async () => {
    const { code, out, server } = await run(
      fixtures("allowance-list-before-update"),
      "allowances", "delete", "2026-10-19", allowanceId, "--dry-run",
    );

    assert.equal(code, 0);
    assert.ok(server.apiRequests.every((r) => r.method === "GET"));
    assert.match(out, /^Dry run, nothing sent: Delete allowance 2026-10-19 – 2026-10-21/);
  });

  it("deletes by id", async () => {
    const { code, out, server } = await run(
      fixtures("allowance-list-before-update", "allowance-delete"),
      "allowances", "delete", "2026-10-19", allowanceId,
    );

    assert.equal(code, 0);
    assert.ok(server.apiRequests.some((r) => r.method === "DELETE"));
    assert.equal(out, `Deleted allowance ${allowanceId}`);
    assert.equal((deleteFixture.query.filter as string[][])[0][2], allowanceId);
  });
});
