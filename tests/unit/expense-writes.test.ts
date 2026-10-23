import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FakeMilltime,
  filterOf,
  jsonResponse,
  loadFixture,
  rowsOf,
  serveFixture,
} from "../support/fake-milltime.ts";
import type { Fixture } from "../support/fake-milltime.ts";
import {
  createExpense,
  deleteExpense,
  getExpenseReceipts,
  planCreateExpense,
  planDeleteExpense,
  planUpdateExpense,
  updateExpense,
} from "../../src/endpoints/expense-writes.ts";
import type { NewExpense, Receipt } from "../../src/endpoints/expense-writes.ts";
import { listCurrencies, listExpenseTypes } from "../../src/endpoints/reference.ts";

const calendarFixture = loadFixture("calendar-week-before-note");
const createFixture = loadFixture("expense-create-with-receipt");
const listAfterCreate = loadFixture("expenses-list-before-edit");
const imagesFixture = loadFixture("expense-images");
const removeReceiptFixture = loadFixture("expense-update-remove-receipt");
const listAfterReceiptRemoved = loadFixture("expenses-list-after-receipt-removed");
const updateProjectFixture = loadFixture("expense-update-project");
const deleteFixture = loadFixture("expense-delete");

const createBody = createFixture.requestBody as Record<string, any>;
const expenseId = (deleteFixture.query.filter as string[][])[0][2];
const expenseDate = createBody.regday as string;
const receipt: Receipt = { name: "receipt.png", mimeType: "image/png", data: new Uint8Array([1, 2, 3]) };

/** Answers GETs on the fixture's path with each response in turn, repeating the last. */
function serveInTurn(...fixtures: Fixture[]) {
  let calls = 0;
  return (request: { method: string; url: URL }) => {
    if (request.method !== "GET" || request.url.pathname !== fixtures[0].path) return undefined;
    const fixture = fixtures[Math.min(calls++, fixtures.length - 1)];
    return jsonResponse(fixture.responseBody, fixture.status);
  };
}

function listWithout(fixture: Fixture, id: string): Fixture {
  const body = fixture.responseBody as { rows: any[] };
  return { ...fixture, responseBody: { ...body, rows: body.rows.filter((r) => r.id !== id) } };
}

function withoutImages(body: unknown): Record<string, unknown> {
  const { allimages: _a, addedimagefiles: _b, deletedimagefiles: _c, ...rest } = body as Record<string, unknown>;
  return rest;
}

async function sampleExpense(): Promise<NewExpense> {
  const server = new FakeMilltime([
    serveFixture(loadFixture("expense-types-new-host")),
    serveFixture(loadFixture("currency-new-host")),
  ]);
  const client = server.createClient();
  const type = (await listExpenseTypes(client)).find((t) => t.id === createBody.expensetypeid);
  const currency = (await listCurrencies(client)).find((c) => c.code === createBody.currencycode);
  assert.ok(type && currency, "the sample type and currency should be in the reference fixtures");
  return {
    type,
    projectId: createBody.projectid,
    date: expenseDate,
    amount: createBody.foreignexpenseamt,
    vat: createBody.foreignexpensevat,
    currency,
    note: createBody.notes,
    receipt,
  };
}

describe("planCreateExpense", () => {
  it("sends the same body as the web UI, with the receipt inline", async () => {
    const server = new FakeMilltime([serveFixture(calendarFixture)], { userId: createBody.userid });

    const plan = await planCreateExpense(server.createClient(), await sampleExpense());

    assert.ok(server.apiRequests.every((r) => r.method === "GET"));
    assert.equal(plan.method, "POST");
    assert.deepEqual(withoutImages(plan.body), withoutImages(createBody));
    const body = plan.body as Record<string, any>;
    const added = { added: true, ImageName: "receipt.png", deleted: false };
    assert.deepEqual(body.allimages, [{ Base64: "data:image/png;base64,AQID", ...added }]);
    assert.deepEqual(body.addedimagefiles, [{ Base64: "AQID", ...added }]);
    assert.deepEqual(body.deletedimagefiles, []);
    // Same image fields as the fixture.
    assert.deepEqual(Object.keys(body.allimages[0]).sort(), Object.keys(createBody.allimages[0]).sort());
  });

  it("shows every field it sends in the summary", async () => {
    const expense = await sampleExpense();
    const server = new FakeMilltime([serveFixture(calendarFixture)], { userId: createBody.userid });

    const plan = await planCreateExpense(server.createClient(), { ...expense, note: "Taxi to the office" });

    assert.equal(
      plan.summary,
      `Add expense ${expense.amount} ${expense.currency.code} ${expense.type.name} on ${expense.date}, ` +
        `project ${expense.projectId}, VAT ${expense.vat}, note "Taxi to the office", receipt receipt.png`,
    );
  });

  it("refuses a type that requires a note when there is none", async () => {
    const expense = await sampleExpense();
    const server = new FakeMilltime([serveFixture(calendarFixture)]);

    await assert.rejects(
      planCreateExpense(server.createClient(), { ...expense, type: { ...expense.type, requiresNote: true }, note: undefined }),
      /requires a note/,
    );
  });

  it("refuses representation types", async () => {
    const expense = await sampleExpense();
    const server = new FakeMilltime([serveFixture(calendarFixture)]);

    await assert.rejects(
      planCreateExpense(server.createClient(), { ...expense, type: { ...expense.type, representation: true } }),
      /[Rr]epresentation/,
    );
  });

  it("refuses a locked day without sending", async () => {
    const expense = await sampleExpense();
    const server = new FakeMilltime([serveFixture(loadFixture("user-calendar"))]);

    await assert.rejects(planCreateExpense(server.createClient(), { ...expense, date: "2026-09-15" }), /locked/);
    assert.ok(server.apiRequests.every((r) => r.method === "GET"));
  });
});

describe("createExpense", () => {
  it("finds the new expense by re-listing the day, since the POST returns no id", async () => {
    const server = new FakeMilltime(
      [
        serveFixture(calendarFixture),
        serveInTurn(listWithout(listAfterCreate, expenseId), listAfterCreate),
        serveFixture(createFixture),
      ],
      { userId: createBody.userid },
    );

    const created = await createExpense(server.createClient(), await sampleExpense());

    assert.equal(created.id, expenseId);
    assert.equal(created.hasReceipt, true);
    const lists = server.apiRequests.filter((r) => r.url.pathname.endsWith("/ExpensesReact") && r.method === "GET");
    assert.deepEqual(filterOf(lists[0]), [["fromDate", "=", expenseDate], ["toDate", "=", expenseDate]]);
  });
});

describe("updateExpense", () => {
  const expense = { id: expenseId, date: expenseDate };

  it("removes receipts like the web UI", async () => {
    const server = new FakeMilltime([
      serveInTurn(listAfterCreate, listAfterReceiptRemoved),
      serveFixture(imagesFixture),
      serveFixture(removeReceiptFixture),
    ]);

    const saved = await updateExpense(server.createClient(), expense, { removeReceipts: true });

    const put = server.apiRequests.find((r) => r.method === "PUT");
    assert.deepEqual(put?.body, removeReceiptFixture.requestBody);
    assert.deepEqual(filterOf(put!), removeReceiptFixture.query.filter);
    assert.equal(saved.hasReceipt, false);
  });

  it("changes the project like the web UI", async () => {
    const newProjectId = (updateProjectFixture.requestBody as Record<string, string>).projectid;
    const server = new FakeMilltime([serveFixture(listAfterReceiptRemoved), serveFixture(updateProjectFixture)]);

    await updateExpense(server.createClient(), expense, { projectId: newProjectId });

    const put = server.apiRequests.find((r) => r.method === "PUT");
    assert.deepEqual(put?.body, updateProjectFixture.requestBody);
    // No receipts: the images are not read.
    assert.ok(server.apiRequests.every((r) => !r.url.pathname.endsWith("/ExpenseImages")));
  });

  it("keeps existing receipts when changing other fields", async () => {
    const server = new FakeMilltime([serveFixture(listAfterCreate), serveFixture(imagesFixture)]);

    const plan = await planUpdateExpense(server.createClient(), expense, { note: "new note" });

    const body = plan.body as Record<string, any>;
    const [image] = rowsOf(imagesFixture);
    assert.deepEqual(body.allimages, [{ ExpenseImageId: image.ExpenseImageId, Base64: image.Base64 }]);
    assert.deepEqual(body.deletedimagefiles, []);
    assert.equal(body.notes, "new note");
    assert.equal(plan.summary, `Update expense ${expenseId} on ${expenseDate}: note "new note"`);
  });

  it("converts a changed amount into the home currency", async () => {
    const server = new FakeMilltime([serveFixture(listAfterReceiptRemoved)]);

    const plan = await planUpdateExpense(server.createClient(), expense, { amount: 80, vat: 16 });

    const body = plan.body as Record<string, any>;
    assert.equal(body.foreignexpenseamt, 80);
    assert.equal(body.foreignexpensevat, 16);
    assert.equal(body.expenseamt, 80 * body.xrate);
    assert.equal(body.expensevat, 16 * body.xrate);
  });

  it("refuses locked expenses without sending", async () => {
    const list = loadFixture("expenses-list");
    const locked = rowsOf(list).find((r) => (r.attestlevel ?? 0) >= 1);
    assert.ok(locked, "fixture should contain a locked expense");
    const server = new FakeMilltime([serveFixture(list)]);

    await assert.rejects(
      updateExpense(server.createClient(), { id: locked.expenseid, date: locked.regday }, { note: "x" }),
      /locked/,
    );
    assert.ok(server.apiRequests.every((r) => r.method === "GET"));
  });
});

describe("deleteExpense", () => {
  it("re-reads the expense and deletes it by id, like the web UI", async () => {
    const server = new FakeMilltime([serveFixture(listAfterReceiptRemoved), serveFixture(deleteFixture)]);

    await deleteExpense(server.createClient(), { id: expenseId, date: expenseDate });

    const remove = server.apiRequests.find((r) => r.method === "DELETE");
    assert.equal(remove?.body, undefined);
    assert.deepEqual(filterOf(remove!), deleteFixture.query.filter);
  });

  it("describes what it would delete", async () => {
    const server = new FakeMilltime([serveFixture(listAfterReceiptRemoved)]);

    const plan = await planDeleteExpense(server.createClient(), { id: expenseId, date: expenseDate });

    assert.match(plan.summary, new RegExp(`^Delete expense .* on ${expenseDate}$`));
  });
});

describe("getExpenseReceipts", () => {
  it("reads receipts by expense id", async () => {
    const server = new FakeMilltime([serveFixture(imagesFixture)]);

    const receipts = await getExpenseReceipts(server.createClient(), expenseId);

    assert.deepEqual(filterOf(server.apiRequests[0]), [["ExpenseId", "=", expenseId]]);
    const [image] = rowsOf(imagesFixture);
    assert.deepEqual(receipts, [{ id: image.ExpenseImageId, dataUri: image.Base64 }]);
  });
});
