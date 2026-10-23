// Read-only calls against the real Milltime instance. Safe to run any time.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLiveClient } from "./client.ts";
import { weekRange } from "../../src/dates.ts";
import { getWeekSummary } from "../../src/endpoints/calendar.ts";
import { listExpenses } from "../../src/endpoints/expenses.ts";
import { getLockStatus } from "../../src/endpoints/lock.ts";
import { listProjects } from "../../src/endpoints/projects.ts";
import { listCurrencies, listExpenseProjects, listExpenseTypes } from "../../src/endpoints/reference.ts";

const client = createLiveClient();
const today = new Date().toISOString().slice(0, 10);

describe("read-only endpoints", () => {
  it("lists projects with activities", async () => {
    const projects = await listProjects(client);
    assert.ok(projects.some((p) => p.activities.length > 0));
  });

  it("summarises the current week", async () => {
    const summary = await getWeekSummary(client, today);
    assert.equal(summary.days.length, 7);
    assert.equal(summary.from, weekRange(today).from);
  });

  it("reads the current week's lock status", async () => {
    const status = await getLockStatus(client, today);
    assert.equal(status.canLock, !status.locked && status.blockers.every((b) => !b.blocking));
  });

  it("lists this month's expenses", async () => {
    const from = `${today.slice(0, 7)}-01`;
    const expenses = await listExpenses(client, { from, to: today });
    assert.ok(expenses.every((e) => e.date >= from && e.date <= today));
  });

  it("lists expense reference data", async () => {
    const [types, currencies, projects] = await Promise.all([
      listExpenseTypes(client),
      listCurrencies(client),
      listExpenseProjects(client),
    ]);
    assert.ok(types.length > 0);
    assert.equal(currencies.filter((c) => c.isHomeCurrency).length, 1);
    assert.ok(projects.length > 0);
  });
});
