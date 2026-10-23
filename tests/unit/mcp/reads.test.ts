// listAllowances reads local midnights; the fixtures are from Sweden.
process.env.TZ = "Europe/Stockholm";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filterOf, jsonResponse } from "../../support/fake-milltime.ts";
import type { Handler } from "../../support/fake-milltime.ts";
import { connectMcp, fixtures, jsonOf } from "../../support/mcp.ts";

const THIS_MONTH = [
  ["fromDate", "=", "2026-10-01"],
  ["toDate", "=", "2026-10-31"],
];

describe("mcp read tools", () => {
  it("lists expenses for this month by default", async () => {
    const { call, server } = await connectMcp(fixtures("expenses-list"));

    const expenses = jsonOf(await call("list_expenses"));

    assert.ok(expenses.length > 0);
    assert.deepEqual(filterOf(server.apiRequests[0]), THIS_MONTH);
  });

  it("lists allowances overlapping the given days", async () => {
    const { call, server } = await connectMcp(fixtures("allowance-list-accommodation-meals"));

    const trips = jsonOf(await call("list_allowances", { from: "2026-10-20", to: "2026-10-20" }));

    const trip = trips.find((t: { from: string }) => t.from === "2026-10-19");
    assert.equal(trip.from, "2026-10-19");
    assert.equal(trip.days[1].privateAccommodation, "domestic");
    assert.deepEqual(filterOf(server.apiRequests[0]), [
      ["fromDate", "=", "2026-10-20"],
      ["toDate", "=", "2026-10-20"],
    ]);
  });

  for (const [tool, fixture] of [
    ["list_expense_types", "expense-types-new-host"],
    ["list_currencies", "currency-new-host"],
    ["list_expense_projects", "project-search-expense"],
    ["list_countries", "country"],
    ["list_allowance_projects", "project-search-allowance"],
  ]) {
    it(`${tool} returns the reference list`, async () => {
      const { call } = await connectMcp(fixtures(fixture));

      assert.ok(jsonOf(await call(tool)).length > 0);
    });
  }

  it("shows the lock status of the week containing the date", async () => {
    const { call, server } = await connectMcp(fixtures("lock-check", "lock-data"));

    const status = jsonOf(await call("get_lock_status", { date: "2026-10-07" }));

    assert.equal(status.from, "2026-10-05");
    assert.ok(server.apiRequests.length > 0);
  });

  it("returns image receipts as images and PDFs as resources", async () => {
    const receipts: Handler = (request) =>
      request.url.pathname.endsWith("/ExpenseImages")
        ? jsonResponse({
            rows: [
              { ExpenseImageId: "1", Base64: "data:image/png;base64,iVBORw0KGgo=" },
              { ExpenseImageId: "2", Base64: "data:application/pdf;base64,JVBERi0=" },
            ],
            success: true,
          })
        : undefined;
    const { call } = await connectMcp([receipts]);

    const { content } = await call("get_expense_receipts", { expenseId: "1" });

    assert.deepEqual(content[0], { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" });
    assert.deepEqual(content[1], {
      type: "resource",
      resource: { uri: "milltime://receipts/2", mimeType: "application/pdf", blob: "JVBERi0=" },
    });
  });
});
