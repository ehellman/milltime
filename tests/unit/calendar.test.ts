import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeMilltime, filterOf, loadFixture, rowsOf, serveFixture } from "../support/fake-milltime.ts";
import { toHours } from "../../src/hours.ts";
import { getCalendar, getWeekSummary } from "../../src/endpoints/calendar.ts";

const calendarFixture = loadFixture("calendar-week-before-note");
const timeInfoFixture = loadFixture("time-info");

describe("getCalendar", () => {
  it("returns only days in the range, with rows and totals", async () => {
    const server = new FakeMilltime([serveFixture(calendarFixture)]);

    const days = await getCalendar(server.createClient(), { from: "2026-10-05", to: "2026-10-11" });

    assert.deepEqual(days.map((d) => d.date), [
      "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11",
    ]);
    for (const day of days) {
      assert.equal(day.reportedHours, day.rows.reduce((sum, row) => sum + row.hours, 0));
      assert.ok(day.rows.every((row) => row.date === day.date));
    }
    assert.ok(days.some((d) => d.rows.length > 0));
  });
});

describe("getWeekSummary", () => {
  it("queries Monday to Sunday and combines calendar with TimeInfo", async () => {
    const server = new FakeMilltime([serveFixture(calendarFixture), serveFixture(timeInfoFixture)]);

    const summary = await getWeekSummary(server.createClient(), "2026-10-08");

    const weekFilter = [["fromDate", "=", "2026-10-05"], ["toDate", "=", "2026-10-11"]];
    assert.ok(server.apiRequests.every((r) => JSON.stringify(filterOf(r)) === JSON.stringify(weekFilter)));
    const info = rowsOf(timeInfoFixture)[0];
    assert.equal(summary.week, 41);
    assert.equal(summary.from, "2026-10-05");
    assert.equal(summary.to, "2026-10-11");
    assert.equal(summary.scheduledHours, info.ScheduledPeriodTime);
    assert.equal(summary.flexBalanceHours, info.FlexTimeCurrent);
    assert.equal(summary.days.length, 7);
    assert.equal(summary.locked, false);
  });
});

describe("flex encoding", () => {
  it("reads negative fractional flex from decimal hours", () => {
    const [flex] = rowsOf(loadFixture("flexdiff-negative-half-hour"));
    // The server sends decimal hours in `hh` and leaves `mm` at 0.
    assert.deepEqual(flex, { hh: -0.5, mm: 0 });
    assert.equal(toHours(flex.hh, flex.mm), -0.5);
  });
});
