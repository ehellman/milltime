import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeMilltime, filterOf, loadFixture, serveFixture } from "../support/fake-milltime.ts";
import { listAllowances } from "../../src/endpoints/allowances.ts";
import { listAllowanceProjects, listCountries } from "../../src/endpoints/reference.ts";

describe("listAllowances", () => {
  it("lists trips overlapping the range, with departure and return as before/after flags", async () => {
    const server = new FakeMilltime([serveFixture(loadFixture("allowance-list"))]);

    const [trip] = await listAllowances(server.createClient(), { from: "2026-10-01", to: "2026-10-31" });

    assert.deepEqual(filterOf(server.apiRequests[0]), [["fromDate", "=", "2026-10-01"], ["toDate", "=", "2026-10-31"]]);
    assert.equal(trip.from, "2026-10-04");
    assert.equal(trip.to, "2026-10-09");
    assert.equal(trip.departedBeforeNoon, false); // deptime 13
    assert.equal(trip.returnedAfter7pm, true); // arrtime 20
    assert.equal(trip.totalCompensation, 3530.9);
    assert.equal(trip.locked, true);
    assert.equal(trip.days.length, 6);
    assert.equal(trip.days[0].country, "NOR");
    assert.equal(trip.days[0].privateAccommodation, null);
    assert.deepEqual(trip.days[1].meals, { breakfast: "hotel", lunch: "deduction", dinner: "paid-myself" });
  });

  it("decodes private accommodation and meals paid by the employer", async () => {
    const server = new FakeMilltime([serveFixture(loadFixture("allowance-list-accommodation-meals"))]);

    const trips = await listAllowances(server.createClient(), { from: "2026-10-01", to: "2026-10-31" });

    const trip = trips.find((t) => t.from === "2026-10-19");
    assert.ok(trip);
    assert.equal(trip.locked, false);
    assert.deepEqual(
      trip.days.map((d) => [d.date, d.country, d.privateAccommodation]),
      [
        ["2026-10-19", "domestic", null],
        ["2026-10-20", "domestic", "domestic"],
        ["2026-10-21", "domestic", null],
        ["2026-10-22", "domestic", null],
      ],
    );
    assert.deepEqual(trip.days[2].meals, { breakfast: "hotel", lunch: "employer", dinner: "paid-myself" });
    assert.equal(trip.totalCompensation, 1035);
  });
});

describe("allowance reference data", () => {
  it("lists enabled countries", async () => {
    const server = new FakeMilltime([serveFixture(loadFixture("country"))]);

    const countries = await listCountries(server.createClient());

    assert.deepEqual(filterOf(server.apiRequests[0]), [["Disabled", "=", "0"]]);
    assert.deepEqual(countries.filter((c) => c.isDefault).map((c) => c.code), ["SWE"]);
    assert.ok(countries.some((c) => c.code === "NOR"));
  });

  it("lists allowance projects from the internal search API", async () => {
    const fixture = loadFixture("project-search-allowance");
    const server = new FakeMilltime([serveFixture(fixture)]);

    const projects = await listAllowanceProjects(server.createClient());

    assert.equal(server.apiRequests[0].url.search, "?view=Allowance&memberOnly=true");
    assert.equal(projects.length, (fixture.responseBody as unknown[]).length);
  });
});
