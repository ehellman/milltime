// Writes against the real Milltime instance, each undone in the same run. Only runs with MILLTIME_LIVE_WRITES=1.
// Uses the current week (Milltime refuses future weeks until earlier ones are locked), on a day where the chosen
// activity has no row. Never locks a week. The allowance covers Monday to Wednesday of the current week.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLiveClient } from "./client.ts";
import { getCalendar, getWeekSummary } from "../../src/endpoints/calendar.ts";
import { createAllowance, deleteAllowance, updateAllowance } from "../../src/endpoints/allowance-writes.ts";
import { DOMESTIC, listAllowances } from "../../src/endpoints/allowances.ts";
import { createExpense, deleteExpense, updateExpense } from "../../src/endpoints/expense-writes.ts";
import { listExpenses } from "../../src/endpoints/expenses.ts";
import type { Expense } from "../../src/endpoints/expenses.ts";
import { activityKey, listProjects } from "../../src/endpoints/projects.ts";
import {
  listAllowanceProjects,
  listCurrencies,
  listExpenseProjects,
  listExpenseTypes,
} from "../../src/endpoints/reference.ts";
import { addDays, weekRange } from "../../src/dates.ts";
import { deleteTimeRow, reportTime, updateTimeRow } from "../../src/endpoints/time.ts";
import type { TimeRow } from "../../src/endpoints/time-row.ts";

const enabled = process.env.MILLTIME_LIVE_WRITES === "1";
const client = createLiveClient();
const today = new Date().toISOString().slice(0, 10);
const NOTE = "milltime-bot live test";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function workingActivity() {
  const activities = (await listProjects(client)).flatMap((p) => p.activities);
  const activity = activities.find((a) => a.absenceType === null && !a.requiresNote && a.timeType === "NORMALTIME");
  assert.ok(activity, "need a working activity without a required note");
  return activity;
}

/** A scheduled, unlocked weekday this week where the activity has no row. */
async function freeDay(key: string): Promise<string | undefined> {
  const { days } = await getWeekSummary(client, today);
  const isFree = (rows: TimeRow[]) => rows.every((row) => (row.task?.id ?? row.activity.id) !== key);
  return days.find((day) => !day.locked && !day.holiday && (day.scheduledHours ?? 0) > 0 && isFree(day.rows))?.date;
}

async function rowsOn(date: string): Promise<TimeRow[]> {
  const [day] = await getCalendar(client, { from: date, to: date });
  return day.rows;
}

async function expenseOn(date: string, id: string): Promise<Expense | undefined> {
  return (await listExpenses(client, { from: date, to: date })).find((e) => e.id === id);
}

describe("live writes", { skip: !enabled && "set MILLTIME_LIVE_WRITES=1 to run" }, () => {
  const cleanup: (() => Promise<void>)[] = [];
  after(async () => {
    for (const undo of cleanup.reverse()) await undo();
  });

  it("reports, edits and deletes a time row", async (t) => {
    const activity = await workingActivity();
    const date = await freeDay(activityKey(activity));
    if (!date) return t.skip("no free day this week");

    const created = await reportTime(client, { activity, date, hours: 1, note: NOTE });
    cleanup.push(async () => {
      if ((await rowsOn(date)).some((r) => r.id === created.id)) await deleteTimeRow(client, created);
    });
    assert.equal(created.hours, 1);

    const updated = await updateTimeRow(client, created, { hours: 1.5, note: `${NOTE} (edited)` });
    assert.equal(updated.hours, 1.5);
    assert.equal(updated.note, `${NOTE} (edited)`);

    await deleteTimeRow(client, created);
    assert.ok((await rowsOn(date)).every((r) => r.id !== created.id));
  });

  it("adds an expense with a receipt, edits it and deletes it", async () => {
    const [types, currencies, projects] = await Promise.all([
      listExpenseTypes(client),
      listCurrencies(client),
      listExpenseProjects(client),
    ]);
    const type = types.find((t) => !t.representation);
    const currency = currencies.find((c) => c.isHomeCurrency);
    assert.ok(type && currency && projects[0], "need an expense type, home currency and project");
    const [day] = await getCalendar(client, { from: today, to: today });
    assert.equal(day.locked, false, "today must be unlocked");

    const created = await createExpense(client, {
      type,
      currency,
      projectId: projects[0].id,
      date: today,
      amount: 100,
      vat: 25,
      note: NOTE,
      receipt: { name: "live-test.png", mimeType: "image/png", data: PNG },
    });
    cleanup.push(async () => {
      if (await expenseOn(today, created.id)) await deleteExpense(client, created);
    });
    assert.equal(created.hasReceipt, true);

    // Not covered by a fixture: editing other fields sends the stored receipts back and keeps them.
    const renoted = await updateExpense(client, created, { note: `${NOTE} (edited)`, amount: 80, vat: 16 });
    assert.equal(renoted.note, `${NOTE} (edited)`);
    assert.equal(renoted.amount, 80);
    assert.equal(renoted.hasReceipt, true);

    const withoutReceipt = await updateExpense(client, created, { removeReceipts: true });
    assert.equal(withoutReceipt.hasReceipt, false);

    await deleteExpense(client, created);
    assert.equal(await expenseOn(today, created.id), undefined);
  });

  it("adds an allowance, edits one day and deletes it", async (t) => {
    const from = weekRange(today).from;
    const to = addDays(from, 2);
    const overlapping = await listAllowances(client, { from, to });
    if (overlapping.length > 0) return t.skip(`an allowance already covers ${from} – ${to}`);
    const [project] = await listAllowanceProjects(client);
    assert.ok(project, "need an allowance project");

    const created = await createAllowance(client, {
      from,
      to,
      departedBeforeNoon: true,
      returnedAfter7pm: true,
      destination: NOTE,
      purpose: NOTE,
      projectId: project.id,
      country: DOMESTIC,
      meals: { breakfast: "paid-myself", lunch: "paid-myself", dinner: "paid-myself" },
      privateAccommodation: false,
    });
    cleanup.push(async () => {
      if ((await listAllowances(client, { from, to })).some((a) => a.id === created.id)) {
        await deleteAllowance(client, created);
      }
    });
    assert.deepEqual([created.from, created.to, created.departedBeforeNoon, created.returnedAfter7pm], [from, to, true, true]);
    assert.ok(created.totalCompensation > 0, "Milltime should compute a compensation");

    const middle = addDays(from, 1);
    const updated = await updateAllowance(client, created, {
      days: { [middle]: { privateAccommodation: true, meals: { breakfast: "hotel", lunch: "employer" } } },
    });
    const day = updated.days.find((d) => d.date === middle);
    assert.equal(day?.privateAccommodation, DOMESTIC);
    assert.deepEqual(day?.meals, { breakfast: "hotel", lunch: "employer", dinner: "paid-myself" });

    await deleteAllowance(client, created);
    assert.ok((await listAllowances(client, { from, to })).every((a) => a.id !== created.id));
  });
});
