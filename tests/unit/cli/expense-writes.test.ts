import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../src/cli/main.ts";
import { FakeMilltime, jsonResponse, loadFixture, serveFixture } from "../../support/fake-milltime.ts";
import type { Fixture, Handler } from "../../support/fake-milltime.ts";
import { captureCli, savedLogin } from "../../support/cli.ts";

const createBody = loadFixture("expense-create-with-receipt").requestBody as Record<string, any>;
const removeReceiptFixture = loadFixture("expense-update-remove-receipt");
const deleteFixture = loadFixture("expense-delete");
const listAfterCreate = loadFixture("expenses-list-before-edit");
const expenseId = (deleteFixture.query.filter as string[][])[0][2];
const date = createBody.regday as string;
const REFERENCE = ["expense-types-new-host", "currency-new-host", "project-search-expense", "calendar-week-before-note"];

let dir: string;
before(async () => (dir = await mkdtemp(join(tmpdir(), "milltime-expenses-"))));
after(async () => rm(dir, { recursive: true, force: true }));

async function run(handlers: Handler[], ...argv: string[]) {
  const server = new FakeMilltime(handlers);
  const cli = captureCli({ server, login: savedLogin() });
  const code = await main(argv, cli.ctx);
  return { code, out: cli.stdout.join("\n"), err: cli.stderr.join("\n"), server };
}

function fixtures(...names: string[]): Handler[] {
  return names.map((name) => serveFixture(loadFixture(name)));
}

/** Answers list GETs with each response in turn, repeating the last. */
function listInTurn(...lists: Fixture[]): Handler {
  let calls = 0;
  return (request) => {
    if (request.method !== "GET" || request.url.pathname !== lists[0].path) return undefined;
    return jsonResponse(lists[Math.min(calls++, lists.length - 1)].responseBody);
  };
}

function listWithout(fixture: Fixture, id: string): Fixture {
  const body = fixture.responseBody as { rows: any[] };
  return { ...fixture, responseBody: { ...body, rows: body.rows.filter((r) => r.id !== id) } };
}

function addArgs(...extra: string[]): string[] {
  return [
    "expenses", "add", date,
    "--type", createBody.expensetypeid,
    "--project", createBody.projectid,
    "--amount", String(createBody.foreignexpenseamt),
    "--vat", String(createBody.foreignexpensevat),
    ...extra,
  ];
}

describe("expenses add", () => {
  it("adds the expense and reports its id", async () => {
    const { code, out, server } = await run(
      [...fixtures(...REFERENCE), listInTurn(listWithout(listAfterCreate, expenseId), listAfterCreate), ...fixtures("expense-create-with-receipt")],
      ...addArgs("--note", "lunch"),
    );

    assert.equal(code, 0);
    const post = server.apiRequests.find((r) => r.method === "POST") as { body: Record<string, unknown> };
    assert.equal(post.body.currencycode, "SEK");
    assert.equal(post.body.notes, "lunch");
    assert.match(out, new RegExp(`^Added expense ${expenseId}: `));
  });

  it("previews with --dry-run, shortening the receipt's base64", async () => {
    const receipt = join(dir, "receipt.png");
    await writeFile(receipt, Buffer.alloc(300, 7));

    const { code, out, server } = await run(fixtures(...REFERENCE), ...addArgs("--receipt", receipt, "--dry-run"));

    assert.equal(code, 0);
    assert.ok(server.apiRequests.every((r) => r.method === "GET"));
    assert.match(out, /^Dry run, nothing sent: Add expense .* receipt receipt\.png\nPOST /);
    assert.match(out, /"Base64": "data:image\/png;base64,.*… \(\d+ chars\)"/);
  });

  it("rejects unknown ids and unsupported receipts before sending", async () => {
    for (const [args, message] of [
      [addArgs("--currency", "XXX"), /Unknown currency "XXX"/],
      [["expenses", "add", "today", "--type", "nope", "--project", "p", "--amount", "1"], /No expense type with id "nope"/],
      [addArgs("--receipt", join(dir, "notes.txt")), /Unsupported receipt/],
    ] as const) {
      const { code, err, server } = await run(fixtures(...REFERENCE), ...args);
      assert.equal(code, 2, args.join(" "));
      assert.match(err, message);
      assert.ok(server.apiRequests.every((r) => r.method === "GET"));
    }
  });
});

describe("expenses edit", () => {
  it("removes receipts like the web UI", async () => {
    const { code, server } = await run(
      fixtures("expenses-list-before-edit", "expense-images", "expense-update-remove-receipt"),
      "expenses", "edit", date, expenseId, "--remove-receipts",
    );

    assert.equal(code, 0);
    const put = server.apiRequests.find((r) => r.method === "PUT");
    assert.deepEqual(put?.body, removeReceiptFixture.requestBody);
  });

  it("refuses to edit without changes", async () => {
    const { code, err } = await run([], "expenses", "edit", date, expenseId);

    assert.equal(code, 2);
    assert.match(err, /Nothing to change/);
  });
});

describe("expenses delete", () => {
  it("deletes the expense", async () => {
    const { code, out, server } = await run(
      fixtures("expenses-list-after-receipt-removed", "expense-delete"),
      "expenses", "delete", date, expenseId,
    );

    assert.equal(code, 0);
    assert.equal(server.apiRequests.filter((r) => r.method === "DELETE").length, 1);
    assert.equal(out, `Deleted expense ${expenseId} on ${date}`);
  });
});

describe("expenses receipt", () => {
  const png = Buffer.from([137, 80, 78, 71]);
  const images = (count: number): Handler => () =>
    jsonResponse({
      rows: Array.from({ length: count }, (_, i) => ({ ExpenseImageId: `img${i}`, Base64: `data:image/png;base64,${png.toString("base64")}` })),
      success: true,
    });

  it("saves the receipt to the given file", async () => {
    const out = join(dir, "single.png");
    const { code } = await run([images(1)], "expenses", "receipt", expenseId, "--out", out);

    assert.equal(code, 0);
    assert.deepEqual(await readFile(out), png);
  });

  it("numbers several receipts and adds the extension", async () => {
    const out = join(dir, "many");
    const { code, out: text } = await run([images(2)], "expenses", "receipt", expenseId, "--out", out);

    assert.equal(code, 0);
    assert.deepEqual(await readFile(`${out}-1.png`), png);
    assert.deepEqual(await readFile(`${out}-2.png`), png);
    assert.equal(text.split("\n").length, 2);
  });

  it("says when there is no receipt", async () => {
    const { out } = await run([images(0)], "expenses", "receipt", expenseId, "--out", join(dir, "none.png"));
    assert.equal(out, `Expense ${expenseId} has no receipt.`);
  });
});
