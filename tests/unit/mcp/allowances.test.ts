// The web UI sends local midnights; the fixtures are from Sweden.
process.env.TZ = "Europe/Stockholm";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadFixture } from "../../support/fake-milltime.ts";
import { connectMcp, fixtures, jsonOf, textOf } from "../../support/mcp.ts";

const createFixture = loadFixture("allowance-create-accommodation-meals");
const updateFixture = loadFixture("allowance-update");
const createBody = createFixture.requestBody as Record<string, any>;
const allowanceId = (updateFixture.query.filter as string[][])[0][2];
const REFERENCE = ["calendar-week-before-note", "country", "project-search-allowance"];

/** The trip in allowance-create-accommodation-meals.json. */
const TRIP = {
  from: "2026-10-19",
  to: "2026-10-22",
  departedBeforeNoon: false,
  returnedAfter7pm: true,
  destination: createBody.allowancedays[0].destination,
  purpose: createBody.purpose,
  projectId: createBody.projectid,
  breakfast: "paid-myself",
  lunch: "paid-myself",
  dinner: "paid-myself",
  privateAccommodation: false,
  days: [
    { date: "2026-10-20", privateAccommodation: true },
    { date: "2026-10-21", breakfast: "hotel", lunch: "employer" },
  ],
};

function withoutRegday(body: unknown): Record<string, unknown> {
  const { regday: _regday, ...rest } = body as Record<string, unknown>;
  return rest;
}

function tokenIn(text: string): string {
  const match = /confirmToken "([^"]+)"/.exec(text);
  assert.ok(match, `no token in: ${text}`);
  return match[1];
}

const onlyReads = (requests: { method: string }[]) => requests.every((r) => r.method === "GET");

describe("create_allowance", () => {
  it("lists every missing field with its valid values and sends nothing", async () => {
    const { call, server } = await connectMcp([]);

    const result = await call("create_allowance", { destination: "Lund" });

    assert.equal(result.isError, true);
    const text = textOf(result);
    for (const field of [
      "from",
      "to",
      "departedBeforeNoon",
      "returnedAfter7pm",
      "purpose",
      "projectId",
      "privateAccommodation",
    ]) {
      assert.match(text, new RegExp(`^- ${field}:`, "m"));
    }
    assert.match(text, /^- breakfast: .*paid-myself.*hotel.*ticket.*employer/m);
    assert.match(text, /^- lunch: .*paid-myself.*deduction.*ticket.*employer/m);
    assert.doesNotMatch(text, /^- (destination|country):/m);
    assert.match(text, /Ask the user/);
    assert.equal(server.apiRequests.length, 0);
  });

  it("previews every day and sends nothing without a token", async () => {
    const { call, server } = await connectMcp(fixtures(...REFERENCE));

    const result = await call("create_allowance", TRIP);

    assert.equal(result.isError, undefined);
    const text = textOf(result);
    assert.match(text, /Nothing sent yet/);
    assert.match(text, /Add allowance 2026-10-19 – 2026-10-22/);
    assert.match(text, /2026-10-21 domestic; breakfast hotel, lunch employer, dinner paid-myself/);
    assert.ok(onlyReads(server.apiRequests));
  });

  it("sends the web UI's body once confirmed, and returns the compensation Milltime computed", async () => {
    const { call, server } = await connectMcp(fixtures(...REFERENCE, "allowance-create-accommodation-meals"));
    const token = tokenIn(textOf(await call("create_allowance", TRIP)));

    const saved = jsonOf(await call("create_allowance", { ...TRIP, confirmToken: token }));

    const post = server.apiRequests.filter((r) => r.method === "POST");
    assert.equal(post.length, 1);
    assert.deepEqual(withoutRegday(post[0].body), withoutRegday(createBody));
    assert.match(saved.done, /^Add allowance/);
    assert.equal(saved.result.totalCompensation, 1035);
  });

  it("sends nothing when the request changed after the preview", async () => {
    const { call, server } = await connectMcp(fixtures(...REFERENCE));
    const token = tokenIn(textOf(await call("create_allowance", TRIP)));

    const result = await call("create_allowance", { ...TRIP, dinner: "deduction", confirmToken: token });

    assert.match(textOf(result), /does not match/);
    assert.notEqual(tokenIn(textOf(result)), token);
    assert.ok(onlyReads(server.apiRequests));
  });

  it("refuses a project the user cannot put allowances on", async () => {
    const { call } = await connectMcp(fixtures(...REFERENCE));

    const result = await call("create_allowance", { ...TRIP, projectId: "123" });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /No allowance project with id "123".*list_allowance_projects/);
  });

  it("passes library refusals on as tool errors", async () => {
    const { call } = await connectMcp(fixtures(...REFERENCE));

    const result = await call("create_allowance", {
      ...TRIP,
      days: [{ date: "2026-10-19", privateAccommodation: true }],
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /departure day/);
  });
});

describe("update_allowance", () => {
  it("changes one day's lunch like the web UI once confirmed", async () => {
    const { call, server } = await connectMcp(
      fixtures(...REFERENCE, "allowance-list-before-update", "allowance-update"),
    );
    const input = { date: "2026-10-20", id: allowanceId, days: [{ date: "2026-10-20", lunch: "deduction" }] };
    const token = tokenIn(textOf(await call("update_allowance", input)));

    const saved = jsonOf(await call("update_allowance", { ...input, confirmToken: token }));

    const put = server.apiRequests.find((r) => r.method === "PUT");
    assert.deepEqual(withoutRegday(put?.body), withoutRegday(updateFixture.requestBody));
    assert.equal(saved.result.totalCompensation, 690);
  });

  it("needs something to change", async () => {
    const { call } = await connectMcp([]);

    const result = await call("update_allowance", { date: "2026-10-20", id: allowanceId });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /Nothing to change/);
  });
});

describe("delete_allowance", () => {
  it("previews, then deletes by id once confirmed", async () => {
    const { call, server } = await connectMcp(fixtures("allowance-list-before-update", "allowance-delete"));
    const input = { date: "2026-10-19", id: allowanceId };

    const preview = textOf(await call("delete_allowance", input));
    assert.match(preview, /Delete allowance 2026-10-19 – 2026-10-21/);
    assert.ok(onlyReads(server.apiRequests));

    await call("delete_allowance", { ...input, confirmToken: tokenIn(preview) });

    assert.ok(server.apiRequests.some((r) => r.method === "DELETE"));
  });

  it("is marked destructive", async () => {
    const { client } = await connectMcp([]);

    const { tools } = await client.listTools();

    assert.equal(tools.find((tool) => tool.name === "delete_allowance")?.annotations?.destructiveHint, true);
  });
});
