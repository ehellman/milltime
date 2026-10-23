import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../src/cli/main.ts";
import { getWeekSummary } from "../../../src/endpoints/calendar.ts";
import { listExpenses } from "../../../src/endpoints/expenses.ts";
import { getLockStatus } from "../../../src/endpoints/lock.ts";
import { activityKey, listProjects } from "../../../src/endpoints/projects.ts";
import { listCurrencies, listExpenseProjects, listExpenseTypes } from "../../../src/endpoints/reference.ts";
import { FakeMilltime, filterOf, jsonResponse, loadFixture, rowsOf, serveFixture, storedSession } from "../../support/fake-milltime.ts";
import { captureCli, savedLogin } from "../../support/cli.ts";

/** Runs the CLI against fixtures with a stored session, and the library against the same fixtures for comparison. */
async function run(fixtures: string[], ...argv: string[]) {
  const handlers = () => fixtures.map((name) => serveFixture(loadFixture(name)));
  const server = new FakeMilltime(handlers());
  const cli = captureCli({ server, login: savedLogin() });
  const code = await main(argv, cli.ctx);
  const library = new FakeMilltime(handlers()).createClient({ kind: "session", session: storedSession() });
  return { code, out: cli.stdout.join("\n"), err: cli.stderr.join("\n"), server, library };
}

function lines(text: string): string[] {
  return text.split("\n");
}

describe("time projects", () => {
  it("lists one line per activity without absence activities", async () => {
    const { code, out, server, library } = await run(["project-favorite"], "time", "projects");
    const projects = await listProjects(library);
    const activities = projects.flatMap((p) => p.activities);
    const working = activities.filter((a) => a.absenceType === null);

    assert.equal(code, 0);
    assert.equal(server.loginCount, 0);
    assert.match(lines(out)[0], /^Project +Customer +Activity +Time type +Requires note +Id$/);
    assert.equal(lines(out).length, 1 + working.length);
    assert.ok(working.every((a) => out.includes(activityKey(a))));
    assert.ok(activities.filter((a) => a.absenceType !== null).every((a) => !out.includes(activityKey(a))));
  });

  it("includes absence activities with --all, and prints the library result as JSON", async () => {
    const { out, library } = await run(["project-favorite"], "time", "projects", "--all", "--json");
    assert.deepEqual(JSON.parse(out), await listProjects(library));
  });
});

describe("expenses reference data", () => {
  it("lists expense types", async () => {
    const { code, out, library } = await run(["expense-types"], "expenses", "types");
    const types = await listExpenseTypes(library);

    assert.equal(code, 0);
    assert.match(lines(out)[0], /^Type +Id +Requires note +No VAT$/);
    assert.equal(lines(out).length, 1 + types.length);
    assert.ok(out.includes(types[0].name));
  });

  it("lists currencies with the home currency marked", async () => {
    const { out } = await run(["currency"], "expenses", "currencies");
    const sek = lines(out).find((line) => line.startsWith("SEK"));
    assert.match(sek!, /home$/);
    assert.doesNotMatch(lines(out).find((line) => line.startsWith("NOK"))!, /home$/);
  });

  it("lists expense projects", async () => {
    const { out, library } = await run(["project-search-expense"], "expenses", "projects");
    const projects = await listExpenseProjects(library);
    assert.equal(lines(out).length, 1 + projects.length);
    assert.ok(projects.every((p) => out.includes(p.id)));
  });

  it("prints the library result as JSON", async () => {
    for (const [fixture, command, list] of [
      ["expense-types", "types", listExpenseTypes],
      ["currency", "currencies", listCurrencies],
      ["project-search-expense", "projects", listExpenseProjects],
    ] as const) {
      const { out, library } = await run([fixture], "expenses", command, "--json");
      assert.deepEqual(JSON.parse(out), await list(library), command);
    }
  });

  it("exits 3 without a stored session", async () => {
    const cli = captureCli();
    assert.equal(await main(["expenses", "types"], cli.ctx), 3);
  });
});

describe("time week", () => {
  const WEEK_FIXTURES = ["calendar-week-before-note", "time-info"];

  it("prints seven days Monday first, with rows and totals", async () => {
    const { code, out, library } = await run(WEEK_FIXTURES, "time", "week", "2026-W41");
    const summary = await getWeekSummary(library, "2026-10-05");
    const dayLines = lines(out).filter((line) => /^[A-Z][a-z]{2} \d{4}-/.test(line));

    assert.equal(code, 0);
    assert.equal(lines(out)[0], "Week 41: 2026-10-05 – 2026-10-11");
    assert.deepEqual(
      dayLines.map((line) => line.slice(0, 14)),
      ["Mon 2026-10-05", "Tue 2026-10-06", "Wed 2026-10-07", "Thu 2026-10-08", "Fri 2026-10-09", "Sat 2026-10-10", "Sun 2026-10-11"],
    );
    const rowCount = summary.days.reduce((sum, day) => sum + day.rows.length, 0);
    assert.equal(lines(out).length, 1 + 7 + rowCount + 1);
    assert.match(out, /userNote 5/);
    assert.match(out, /activityname 18 \/ name 12 /);
    assert.doesNotMatch(out, /name 11 \/ name 11/);
    assert.match(lines(out).at(-1)!, /^Worked [\d.]+h of [\d.]+h · absence [\d.]+h · remaining [\d.]+h · flex balance -?[\d.]+h$/);
  });

  it("marks a locked week", async () => {
    const calendar = structuredClone(loadFixture("calendar-week-before-note"));
    for (const month of rowsOf(calendar)) {
      for (const week of month.weeks) for (const day of week.days) day.attestlevel = 1;
    }
    const server = new FakeMilltime([serveFixture(calendar), serveFixture(loadFixture("time-info"))]);
    const cli = captureCli({ server, login: savedLogin() });

    await main(["time", "week", "2026-W41"], cli.ctx);

    assert.equal(lines(cli.stdout.join("\n"))[0], "Week 41: 2026-10-05 – 2026-10-11 (locked)");
  });

  it("shows day flex, internal notes and tasks", async () => {
    const calendar = structuredClone(loadFixture("calendar-week-before-note"));
    const days = rowsOf(calendar).flatMap((month) => month.weeks.flatMap((week: any) => week.days));
    const monday = days.find((day) => day.regday === "2026-10-05");
    monday.flexdiff = { hh: 1, mm: 30 };
    monday.projectregistrations[0].internalnote = "secret plan";
    const rowId = monday.projectregistrations[0].projectregistrationid;
    const server = new FakeMilltime([serveFixture(calendar), serveFixture(loadFixture("time-info"))]);
    const cli = captureCli({ server, login: savedLogin() });

    await main(["time", "week", "2026-W41"], cli.ctx);

    const out = lines(cli.stdout.join("\n"));
    assert.match(out[1], /^Mon 2026-10-05 +8h \/ 8h +flex \+1\.5h$/);
    assert.match(out[2], new RegExp(`activityname 18 / name 12 +8h +${rowId} +internal: secret plan$`));
    assert.doesNotMatch(out[3], /flex/);
  });

  it("selects the week from the argument", async () => {
    for (const [arg, from, to] of [
      [undefined, "2026-10-19", "2026-10-25"],
      ["prev", "2026-10-12", "2026-10-18"],
      ["2026-10-08", "2026-10-05", "2026-10-11"],
    ] as const) {
      const { server } = await run(WEEK_FIXTURES, "time", "week", ...(arg ? [arg] : []));
      const expected = [["fromDate", "=", from], ["toDate", "=", to]];
      assert.ok(server.apiRequests.every((r) => JSON.stringify(filterOf(r)) === JSON.stringify(expected)), String(arg));
    }
  });

  it("prints the library result as JSON", async () => {
    const { out, library } = await run(WEEK_FIXTURES, "time", "week", "2026-10-05", "--json");
    assert.deepEqual(JSON.parse(out), await getWeekSummary(library, "2026-10-05"));
  });

  it("rejects an invalid week", async () => {
    const { code, err } = await run(WEEK_FIXTURES, "time", "week", "w99");
    assert.equal(code, 2);
    assert.match(err, /Invalid week "w99"/);
  });
});

describe("lock status", () => {
  it("shows a blocked week with the blocker message", async () => {
    const { code, out } = await run(["lock-check-blocked", "lock-data"], "lock", "status", "w42");
    const message = rowsOf(loadFixture("lock-check-blocked"))[0].lockMessage;

    assert.equal(code, 0);
    assert.equal(lines(out)[0], "Week 42: 2026-10-12 – 2026-10-18");
    assert.equal(lines(out)[1], "Status: cannot be locked yet");
    assert.equal(lines(out)[2], `  Blocked: ${message}`);
  });

  it("shows a week that can be locked, with only non-zero buckets", async () => {
    const { out } = await run(["lock-check", "lock-data"], "lock", "status", "w42");

    assert.equal(lines(out)[1], "Status: can be locked");
    assert.match(out, /^Travel time: label 2 4\.5h$/m);
    assert.doesNotMatch(out, /Overtime/);
  });

  it("queries the selected week and prints the library result as JSON", async () => {
    const { out, server, library } = await run(["lock-check", "lock-data"], "lock", "status", "prev", "--json");

    assert.ok(server.apiRequests.every((r) => JSON.stringify(filterOf(r)).includes('["fromDate","=","2026-10-12"]')));
    assert.deepEqual(JSON.parse(out), await getLockStatus(library, "2026-10-12"));
  });
});

describe("expenses list", () => {
  it("lists the month's expenses with a home-currency total", async () => {
    const { code, out, server, library } = await run(["expenses-list"], "expenses", "list", "2026-10");
    const expenses = await listExpenses(library, { from: "2026-10-01", to: "2026-10-31" });
    const total = expenses.reduce((sum, e) => sum + e.amountInHomeCurrency, 0);

    assert.equal(code, 0);
    assert.deepEqual(filterOf(server.apiRequests[0]), [["fromDate", "=", "2026-10-01"], ["toDate", "=", "2026-10-31"]]);
    assert.match(lines(out)[0], /^Date +Type +Project +Amount +VAT +Home amount +Receipt +Locked +Id +Note$/);
    assert.equal(lines(out).length, 1 + expenses.length + 1);
    assert.match(lines(out)[1], /^2026-10-05 .* 116\.00 NOK +0\.00 +120\.57 +yes +yes +\d+ +notes 1$/);
    assert.match(lines(out)[2], / 640\.00 SEK +36\.23 +640\.00 /);
    assert.equal(lines(out).at(-1), `Total: ${total.toFixed(2)} in home currency`);
  });

  it("defaults to the current month", async () => {
    const { server } = await run(["expenses-list"], "expenses", "list");
    assert.deepEqual(filterOf(server.apiRequests[0]), [["fromDate", "=", "2026-10-01"], ["toDate", "=", "2026-10-31"]]);
  });

  it("says when there are no expenses", async () => {
    const server = new FakeMilltime([() => jsonResponse({ rows: [], success: true })]);
    const cli = captureCli({ server, login: savedLogin() });

    assert.equal(await main(["expenses", "list", "2026-02"], cli.ctx), 0);
    assert.equal(cli.stdout.join("\n"), "No expenses in 2026-02.");
  });

  it("prints the library result as JSON", async () => {
    const { out, library } = await run(["expenses-list"], "expenses", "list", "2026-10", "--json");
    assert.deepEqual(JSON.parse(out), await listExpenses(library, { from: "2026-10-01", to: "2026-10-31" }));
  });
});
