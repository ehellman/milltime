import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMonthArg, parseWeekArg } from "../../../src/cli/args.ts";
import { UsageError } from "../../../src/cli/errors.ts";

const TODAY = "2026-10-22"; // Thursday, ISO week 43

describe("parseWeekArg", () => {
  it("defaults to the current week", () => {
    assert.equal(parseWeekArg(undefined, TODAY), "2026-10-19");
    assert.equal(parseWeekArg("today", TODAY), "2026-10-19");
  });

  it("steps to the previous and next week", () => {
    assert.equal(parseWeekArg("prev", TODAY), "2026-10-12");
    assert.equal(parseWeekArg("next", TODAY), "2026-10-26");
  });

  it("selects the week containing a date", () => {
    assert.equal(parseWeekArg("2026-10-11", TODAY), "2026-10-05");
    assert.equal(parseWeekArg("2027-01-01", TODAY), "2026-12-28");
  });

  it("accepts ISO weeks with and without a year", () => {
    assert.equal(parseWeekArg("2026-W42", TODAY), "2026-10-12");
    assert.equal(parseWeekArg("2026-w01", TODAY), "2025-12-29");
    assert.equal(parseWeekArg("2026-W53", TODAY), "2026-12-28");
    assert.equal(parseWeekArg("w42", TODAY), "2026-10-12");
    assert.equal(parseWeekArg("W7", TODAY), "2026-02-09");
  });

  it("rejects invalid weeks", () => {
    for (const arg of ["2026-13-01", "2026-02-30", "2025-W53", "w0", "w54", "last", "42", ""]) {
      assert.throws(() => parseWeekArg(arg, TODAY), UsageError, arg);
    }
  });
});

describe("parseMonthArg", () => {
  it("defaults to the current month", () => {
    assert.deepEqual(parseMonthArg(undefined, TODAY), { from: "2026-10-01", to: "2026-10-31" });
  });

  it("covers the whole month, including leap Februaries", () => {
    assert.deepEqual(parseMonthArg("2026-02", TODAY), { from: "2026-02-01", to: "2026-02-28" });
    assert.deepEqual(parseMonthArg("2028-02", TODAY), { from: "2028-02-01", to: "2028-02-29" });
    assert.deepEqual(parseMonthArg("2026-12", TODAY), { from: "2026-12-01", to: "2026-12-31" });
  });

  it("rejects invalid months", () => {
    for (const arg of ["2026-13", "2026-00", "2026-1", "october", "2026-10-01"]) {
      assert.throws(() => parseMonthArg(arg, TODAY), UsageError, arg);
    }
  });
});
