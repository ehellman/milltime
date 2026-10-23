// The web UI sends local midnights; the fixtures are from Sweden.
process.env.TZ = "Europe/Stockholm";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeMilltime, filterOf, loadFixture, rowsOf, serveFixture } from "../support/fake-milltime.ts";
import {
  createAllowance,
  deleteAllowance,
  planCreateAllowance,
  planDeleteAllowance,
  planUpdateAllowance,
  updateAllowance,
} from "../../src/endpoints/allowance-writes.ts";
import type { NewAllowance } from "../../src/endpoints/allowance-writes.ts";
import { DOMESTIC } from "../../src/endpoints/allowances.ts";
import type { Meals } from "../../src/endpoints/allowances.ts";

const calendar = loadFixture("calendar-week-before-note");
const countries = loadFixture("country");
const createFixture = loadFixture("allowance-create");
const accommodationFixture = loadFixture("allowance-create-accommodation-meals");
const listBeforeUpdate = loadFixture("allowance-list-before-update");
const updateFixture = loadFixture("allowance-update");
const deleteFixture = loadFixture("allowance-delete");

const PAID: Meals = { breakfast: "paid-myself", lunch: "paid-myself", dinner: "paid-myself" };

function bodyOf(fixture: { requestBody: unknown }): Record<string, any> {
  return fixture.requestBody as Record<string, any>;
}

/** `regday` is the day the form was saved. */
function withoutRegday(body: unknown): Record<string, unknown> {
  const { regday: _regday, ...rest } = body as Record<string, unknown>;
  return rest;
}

/** allowance-create.json: three domestic days, out before 12, back after 19, dinner deducted on the last day. */
function sampleTrip(): NewAllowance {
  const body = bodyOf(createFixture);
  return {
    from: "2026-10-19",
    to: "2026-10-21",
    departedBeforeNoon: true,
    returnedAfter7pm: true,
    destination: body.allowancedays[0].destination,
    purpose: body.purpose,
    projectId: body.projectid,
    country: DOMESTIC,
    meals: PAID,
    privateAccommodation: false,
    days: { "2026-10-21": { meals: { dinner: "deduction" } } },
  };
}

function server(...fixtures: ReturnType<typeof loadFixture>[]) {
  return new FakeMilltime([serveFixture(calendar), serveFixture(countries), ...fixtures.map(serveFixture)]);
}

describe("planCreateAllowance", () => {
  it("sends the same body as the web UI", async () => {
    const fake = server();

    const plan = await planCreateAllowance(fake.createClient(), sampleTrip());

    assert.ok(fake.apiRequests.every((r) => r.method === "GET"));
    assert.equal(plan.method, "POST");
    assert.deepEqual(withoutRegday(plan.body), withoutRegday(bodyOf(createFixture)));
  });

  it("encodes private accommodation, a late departure and meals in the hotel price or paid by the employer", async () => {
    const body = bodyOf(accommodationFixture);

    const plan = await planCreateAllowance(server().createClient(), {
      ...sampleTrip(),
      to: "2026-10-22",
      departedBeforeNoon: false,
      destination: body.allowancedays[0].destination,
      purpose: body.purpose,
      days: {
        "2026-10-20": { privateAccommodation: true },
        "2026-10-21": { meals: { breakfast: "hotel", lunch: "employer" } },
      },
    });

    assert.deepEqual(withoutRegday(plan.body), withoutRegday(body));
  });

  it("puts trip-wide private accommodation on every night but not the departure day", async () => {
    const plan = await planCreateAllowance(server().createClient(), { ...sampleTrip(), privateAccommodation: true });

    const days = (plan.body as any).allowancedays;
    assert.deepEqual(
      days.map((d: any) => [d.nightcountrycode, d.night]),
      [["-1", false], ["", true], ["", true]],
    );
  });

  it("sends foreign countries by code and the home country as domestic", async () => {
    const plan = await planCreateAllowance(server().createClient(), {
      ...sampleTrip(),
      country: "nor",
      privateAccommodation: true,
      days: { "2026-10-21": { country: "SWE" } },
    });

    const days = (plan.body as any).allowancedays;
    assert.deepEqual(
      days.map((d: any) => [d.daycountrycode, d.nightcountrycode]),
      [["NOR", "-1"], ["NOR", "NOR"], ["-1", ""]],
    );
  });

  it("lists every day in the summary", async () => {
    const plan = await planCreateAllowance(server().createClient(), sampleTrip());

    assert.match(plan.summary, /^Add allowance 2026-10-19 – 2026-10-21 to /);
    assert.match(plan.summary, /left before 12, back after 19/);
    assert.match(plan.summary, /2026-10-21 domestic; breakfast paid-myself, lunch paid-myself, dinner deduction/);
  });

  for (const [name, change, error] of [
    ["an end before the start", { to: "2026-10-18" }, /ends .* before it starts/],
    ["an override outside the trip", { days: { "2026-10-25": { meals: { lunch: "employer" } } } }, /not a day of the trip/],
    ["private accommodation on the departure day", { days: { "2026-10-19": { privateAccommodation: true } } }, /departure day/],
    ["an unknown country", { country: "XYZ" }, /Unknown country "XYZ"/],
  ] as const) {
    it(`refuses ${name} without sending`, async () => {
      const fake = server();

      await assert.rejects(planCreateAllowance(fake.createClient(), { ...sampleTrip(), ...change }), error);
      assert.ok(fake.apiRequests.every((r) => r.method === "GET"));
    });
  }

  it("refuses locked days", async () => {
    const fake = new FakeMilltime([serveFixture(loadFixture("user-calendar")), serveFixture(countries)]);

    await assert.rejects(
      planCreateAllowance(fake.createClient(), { ...sampleTrip(), from: "2026-09-14", to: "2026-09-15", days: {} }),
      /Locked days in the trip: .*2026-09-15/,
    );
  });
});

describe("createAllowance", () => {
  it("returns the saved allowance with the compensation Milltime computed", async () => {
    const created = await createAllowance(server(createFixture).createClient(), sampleTrip());

    assert.equal(created.totalCompensation, 795);
    assert.equal(created.from, "2026-10-19");
    assert.ok(created.id);
  });
});

describe("updateAllowance", () => {
  const id = (updateFixture.query.filter as string[][])[0][2];
  const allowance = { id, from: "2026-10-19" };

  it("sends the same body as the web UI", async () => {
    const fake = server(listBeforeUpdate, updateFixture);

    const updated = await updateAllowance(fake.createClient(), allowance, {
      days: { "2026-10-20": { meals: { lunch: "deduction" } } },
    });

    const put = fake.apiRequests.find((r) => r.method === "PUT");
    assert.deepEqual(filterOf(put!), updateFixture.query.filter);
    assert.deepEqual(withoutRegday(put?.body), withoutRegday(bodyOf(updateFixture)));
    assert.equal(updated.totalCompensation, 690);
  });

  it("applies trip-wide meals to every day", async () => {
    const plan = await planUpdateAllowance(server(listBeforeUpdate).createClient(), allowance, {
      meals: { breakfast: "hotel" },
    });

    const days = (plan.body as any).allowancedays;
    assert.deepEqual(days.map((d: any) => [d.breakfastpaid, d.dinnerpaid]), [[1, 0], [1, 0], [1, 1]]);
  });

  it("copies the nearest day when the trip gets longer, and keeps the departure day without accommodation", async () => {
    const plan = await planUpdateAllowance(server(listBeforeUpdate).createClient(), allowance, {
      from: "2026-10-18",
      to: "2026-10-22",
      privateAccommodation: true,
    });

    const days = (plan.body as any).allowancedays;
    assert.deepEqual(
      days.map((d: any) => [d.regday, d.dinnerpaid, d.nightcountrycode, d.deptime, d.arrtime]),
      [
        ["2026-10-18", 0, "-1", "11.00", undefined],
        ["2026-10-19", 0, "", undefined, undefined],
        ["2026-10-20", 0, "", undefined, undefined],
        ["2026-10-21", 1, "", undefined, undefined],
        ["2026-10-22", 1, "", undefined, "20.00"],
      ],
    );
    assert.equal((plan.body as any).period._from, "2026-10-17T22:00:00.000Z");
  });

  it("refuses allowances with locked days without sending", async () => {
    const list = loadFixture("allowance-list");
    const fake = server(list);
    const locked = { id: rowsOf(list)[0].allowanceid, from: "2026-10-04" };

    await assert.rejects(updateAllowance(fake.createClient(), locked, { purpose: "x" }), /locked/);
    assert.ok(fake.apiRequests.every((r) => r.method === "GET"));
  });
});

describe("deleteAllowance", () => {
  const id = (deleteFixture.query.filter as string[][])[0][2];

  it("re-reads the allowance and deletes it by id, like the web UI", async () => {
    const fake = server(listBeforeUpdate, deleteFixture);

    await deleteAllowance(fake.createClient(), { id, from: "2026-10-19" });

    const remove = fake.apiRequests.find((r) => r.method === "DELETE");
    assert.equal(remove?.body, undefined);
    assert.deepEqual(filterOf(remove!), deleteFixture.query.filter);
    assert.deepEqual(filterOf(fake.apiRequests[0]), [["fromDate", "=", "2026-10-19"], ["toDate", "=", "2026-10-19"]]);
  });

  it("describes what it would delete", async () => {
    const plan = await planDeleteAllowance(server(listBeforeUpdate).createClient(), { id, from: "2026-10-19" });

    assert.match(plan.summary, /^Delete allowance 2026-10-19 – 2026-10-21 to .* \(795\)$/);
  });
});
