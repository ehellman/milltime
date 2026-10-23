import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeMilltime, filterOf, loadFixture, rowsOf, serveFixture } from "../support/fake-milltime.ts";
import { listExpenses } from "../../src/endpoints/expenses.ts";

describe("listExpenses", () => {
  it("sends the date filter and maps expenses", async () => {
    const fixture = loadFixture("expenses-list");
    const server = new FakeMilltime([serveFixture(fixture)]);

    const expenses = await listExpenses(server.createClient(), { from: "2026-10-01", to: "2026-10-31" });

    assert.deepEqual(filterOf(server.apiRequests[0]), fixture.query.filter);
    const raw = rowsOf(fixture)[0];
    assert.equal(expenses.length, rowsOf(fixture).length);
    assert.deepEqual(expenses[0], {
      id: raw.expenseid,
      date: raw.regday,
      type: { id: raw.expensetypeid, name: raw.expensetypename },
      project: { id: raw.projectid, name: raw.projectname, number: raw.projectnr },
      amount: raw.foreignexpenseamt,
      vat: raw.foreignexpensevat,
      currency: raw.currencycode,
      exchangeRate: raw.xrate,
      amountInHomeCurrency: raw.expenseamt,
      note: raw.notes,
      hasReceipt: raw.hasimages,
      locked: raw.attestlevel >= 1,
    });
  });
});
