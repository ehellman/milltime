import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isoWeekNumber, weekRange } from "../../src/dates.ts";

describe("dates", () => {
  it("finds Monday to Sunday for any day of the week", () => {
    assert.deepEqual(weekRange("2026-10-05"), { from: "2026-10-05", to: "2026-10-11" });
    assert.deepEqual(weekRange("2026-10-11"), { from: "2026-10-05", to: "2026-10-11" });
    assert.deepEqual(weekRange("2026-10-01"), { from: "2026-09-28", to: "2026-10-04" });
    assert.deepEqual(weekRange("2027-01-01"), { from: "2026-12-28", to: "2027-01-03" });
  });

  it("computes ISO week numbers", () => {
    assert.equal(isoWeekNumber("2026-10-10"), 41);
    assert.equal(isoWeekNumber("2026-10-12"), 42);
    assert.equal(isoWeekNumber("2027-01-01"), 53);
  });
});
