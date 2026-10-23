import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonResponse, loadFixture, rowsOf } from "../../support/fake-milltime.ts";
import type { Handler } from "../../support/fake-milltime.ts";
import { connectMcp, fixtures, jsonOf, textOf } from "../../support/mcp.ts";

const timeCreateBody = loadFixture("time-create").requestBody as Record<string, any>;
const expenseBody = loadFixture("expense-create-with-receipt").requestBody as Record<string, any>;
const expenseId = (loadFixture("expense-delete").query.filter as string[][])[0][2];
const unlockedRow = rowsOf(loadFixture("calendar-week-before-note"))
  .flatMap((m) => m.weeks.flatMap((w: any) => w.days.flatMap((d: any) => d.projectregistrations)))
  .find((r) => (r.attestlevel ?? 0) < 1);

function tokenIn(text: string): string {
  const match = /confirmToken "([^"]+)"/.exec(text);
  assert.ok(match, `no token in: ${text}`);
  return match[1];
}

const methods = (requests: { method: string }[]) => requests.map((r) => r.method).filter((m) => m !== "GET");

/** Calls the tool, checks the preview sent nothing, then confirms it. */
async function previewThenConfirm(
  mcp: Awaited<ReturnType<typeof connectMcp>>,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ preview: string; confirmed: any }> {
  const preview = textOf(await mcp.call(tool, args));
  assert.deepEqual(methods(mcp.server.apiRequests), [], `${tool} preview sent a write`);
  const confirmed = jsonOf(await mcp.call(tool, { ...args, confirmToken: tokenIn(preview) }));
  return { preview, confirmed };
}

describe("time write tools", () => {
  const activityKey = timeCreateBody.planningtaskid ?? timeCreateBody.activity;

  it("report_time previews, then reports once confirmed", async () => {
    const mcp = await connectMcp(fixtures("project-favorite", "calendar-week-before-note", "time-create"));

    const { preview } = await previewThenConfirm(mcp, "report_time", {
      rows: [{ date: "2026-10-10", activityKey, hours: 5, note: "Planning" }],
    });

    assert.match(preview, /Report 5h .* on 2026-10-10, note "Planning"/);
    assert.deepEqual(methods(mcp.server.apiRequests), ["POST"]);
  });

  it("report_time previews several rows and reports them all under one token", async () => {
    const mcp = await connectMcp(fixtures("project-favorite", "calendar-week-before-note", "time-create"));
    const rows = [
      { date: "2026-10-09", activityKey, hours: 4 },
      { date: "2026-10-10", activityKey, hours: 5 },
    ];

    const { preview } = await previewThenConfirm(mcp, "report_time", { rows });

    assert.match(preview, /Report 4h .* on 2026-10-09\nReport 5h .* on 2026-10-10\n/);
    assert.deepEqual(methods(mcp.server.apiRequests), ["POST", "POST"]);
  });

  it("report_time says which rows were sent when one fails", async () => {
    let posts = 0;
    const failSecondPost: Handler = (request) =>
      request.method === "POST" && ++posts === 2
        ? jsonResponse({ success: false, message: "Server says no" })
        : undefined;
    const mcp = await connectMcp([
      failSecondPost,
      ...fixtures("project-favorite", "calendar-week-before-note", "time-create"),
    ]);
    const rows = [
      { date: "2026-10-09", activityKey, hours: 4 },
      { date: "2026-10-10", activityKey, hours: 5 },
    ];
    const token = tokenIn(textOf(await mcp.call("report_time", { rows })));

    const result = await mcp.call("report_time", { rows, confirmToken: token });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /Reported: 4h .* on 2026-10-09\. Not reported: 5h .* on 2026-10-10\./);
    assert.match(textOf(result), /Do not send the reported rows again/);
  });

  it("report_time refuses an unknown activity", async () => {
    const { call } = await connectMcp(fixtures("project-favorite"));

    const result = await call("report_time", { rows: [{ date: "2026-10-10", activityKey: "nope", hours: 1 }] });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /No activity with key "nope".*list_projects/);
  });

  it("update_time_row needs hours or a note", async () => {
    const { call } = await connectMcp([]);

    const result = await call("update_time_row", { date: "2026-10-10", rowId: "1" });

    assert.match(textOf(result), /Nothing to change/);
  });

  it("delete_time_row deletes once confirmed", async () => {
    const mcp = await connectMcp(fixtures("calendar-week-before-note", "time-delete"));

    await previewThenConfirm(mcp, "delete_time_row", {
      date: unlockedRow.regday,
      rowId: unlockedRow.projectregistrationid,
    });

    assert.deepEqual(methods(mcp.server.apiRequests), ["DELETE"]);
  });
});

describe("expense write tools", () => {
  const REFERENCE = [
    "expense-types-new-host",
    "currency-new-host",
    "project-search-expense",
    "calendar-week-before-note",
  ];

  it("create_expense reads the receipt file and previews without sending", async () => {
    const dir = await mkdtemp(join(tmpdir(), "milltime-mcp-"));
    const receiptPath = join(dir, "receipt.png");
    await writeFile(receiptPath, new Uint8Array([1, 2, 3]));
    const { call, server } = await connectMcp(fixtures(...REFERENCE));

    const result = await call("create_expense", {
      date: expenseBody.regday,
      typeId: expenseBody.expensetypeid,
      projectId: expenseBody.projectid,
      amount: 100,
      vat: 25,
      receiptPath,
    });

    assert.equal(result.isError, undefined, textOf(result));
    assert.match(textOf(result), /confirmToken "/);
    assert.deepEqual(methods(server.apiRequests), []);
  });

  it("create_expense refuses an unknown type and an unsupported receipt", async () => {
    const { call } = await connectMcp(fixtures(...REFERENCE));
    const base = { typeId: expenseBody.expensetypeid, projectId: expenseBody.projectid, amount: 1 };

    assert.match(textOf(await call("create_expense", { ...base, typeId: "x" })), /No expense type with id "x"/);
    assert.match(textOf(await call("create_expense", { ...base, receiptPath: "/tmp/a.txt" })), /Unsupported receipt/);
  });

  it("delete_expense deletes once confirmed", async () => {
    const mcp = await connectMcp(fixtures("expenses-list-after-receipt-removed", "expense-delete"));

    await previewThenConfirm(mcp, "delete_expense", { date: expenseBody.regday, id: expenseId });

    assert.deepEqual(methods(mcp.server.apiRequests), ["DELETE"]);
  });
});

describe("lock_week", () => {
  it("says it cannot be undone, and locks only once confirmed", async () => {
    const mcp = await connectMcp(fixtures("lock-check", "lock-data", "lock-week"));

    const { preview } = await previewThenConfirm(mcp, "lock_week", { date: "2026-10-07" });

    assert.match(preview, /Lock week 41 .*cannot be undone/);
    assert.deepEqual(methods(mcp.server.apiRequests), ["POST"]);
  });

  it("is refused while something blocks locking", async () => {
    const { call, server } = await connectMcp(fixtures("lock-check-blocked", "lock-data"));

    const result = await call("lock_week", { date: "2026-10-12" });

    assert.equal(result.isError, true);
    assert.deepEqual(methods(server.apiRequests), []);
  });

  it("is marked destructive and warns in its description", async () => {
    const { client } = await connectMcp([]);

    const tool = (await client.listTools()).tools.find((t) => t.name === "lock_week");

    assert.equal(tool?.annotations?.destructiveHint, true);
    assert.match(tool?.description ?? "", /CANNOT BE UNDONE/);
  });
});
