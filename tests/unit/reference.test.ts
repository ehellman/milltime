import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeMilltime, loadFixture, rowsOf, serveFixture } from "../support/fake-milltime.ts";
import { listCurrencies, listExpenseProjects, listExpenseTypes } from "../../src/endpoints/reference.ts";

describe("reference data", () => {
  it("lists enabled expense types", async () => {
    const fixture = loadFixture("expense-types");
    const server = new FakeMilltime([serveFixture(fixture)]);

    const types = await listExpenseTypes(server.createClient());

    assert.equal(types.length, rowsOf(fixture).filter((r) => r.Disabled === 0).length);
    assert.ok(types.every((t) => t.name.length > 0));
  });

  it("lists currencies with exchange rates", async () => {
    const server = new FakeMilltime([serveFixture(loadFixture("currency"))]);

    const currencies = await listCurrencies(server.createClient());

    const nok = currencies.find((c) => c.code === "NOK");
    assert.ok(nok && nok.rate > 0);
    assert.deepEqual(currencies.filter((c) => c.isHomeCurrency).map((c) => c.code), ["SEK"]);
  });

  it("lists expense projects from the internal search API", async () => {
    const fixture = loadFixture("project-search-expense");
    const server = new FakeMilltime([serveFixture(fixture)]);

    const projects = await listExpenseProjects(server.createClient());

    assert.equal(server.apiRequests[0].url.search, "?view=Expense&memberOnly=true");
    assert.equal(projects.length, (fixture.responseBody as unknown[]).length);
    assert.ok(projects.every((p) => p.id && p.name));
  });
});
