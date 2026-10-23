import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatHours } from "../../../src/cli/format/hours.ts";
import { formatTable } from "../../../src/cli/format/table.ts";

describe("formatHours", () => {
  it("formats hours without trailing zeros", () => {
    assert.equal(formatHours(8), "8h");
    assert.equal(formatHours(7.5), "7.5h");
    assert.equal(formatHours(7.25), "7.25h");
    assert.equal(formatHours(1 / 3), "0.33h");
    assert.equal(formatHours(-1.5), "-1.5h");
    assert.equal(formatHours(0), "0h");
  });

  it("shows a dash for missing hours", () => {
    assert.equal(formatHours(null), "–");
  });
});

describe("formatTable", () => {
  it("aligns columns and trims trailing space", () => {
    const table = formatTable(
      ["Project", "Hours"],
      [
        ["Internal", "7.5h"],
        ["Customer project", "0.5h"],
      ],
    );
    assert.equal(table, ["Project           Hours", "Internal          7.5h", "Customer project  0.5h"].join("\n"));
  });

  it("right-aligns columns on request", () => {
    const table = formatTable(["Code", "Rate"], [["SEK", "1"], ["EUR", "11.2"]], { align: ["left", "right"] });
    assert.equal(table, ["Code  Rate", "SEK      1", "EUR   11.2"].join("\n"));
  });

  it("prints only the header for no rows", () => {
    assert.equal(formatTable(["A", "B"], []), "A  B");
  });
});
