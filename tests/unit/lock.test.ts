import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeMilltime, filterOf, loadFixture, serveFixture } from "../support/fake-milltime.ts";
import { getLockStatus, lockWeek, planLockWeek } from "../../src/endpoints/lock.ts";
import type { Fixture } from "../support/fake-milltime.ts";

const lockData = loadFixture("lock-data");

describe("getLockStatus", () => {
  it("allows locking an open week without blockers", async () => {
    const server = new FakeMilltime([serveFixture(loadFixture("lock-check")), serveFixture(lockData)]);

    const status = await getLockStatus(server.createClient(), "2026-10-07");

    for (const request of server.apiRequests) {
      assert.deepEqual(filterOf(request), [
        ["fromDate", "=", "2026-10-05"], ["toDate", "=", "2026-10-11"], ["period", "=", "week"],
      ]);
    }
    assert.equal(status.locked, false);
    assert.equal(status.canLock, true);
    assert.deepEqual(status.blockers, []);
    assert.equal(status.reportedHours, 40);
    assert.deepEqual(status.travelTime.map((b) => b.code), ["TravelTime1", "TravelTime2"]);
  });

  it("reports blockers and refuses locking", async () => {
    const server = new FakeMilltime([serveFixture(loadFixture("lock-check-blocked")), serveFixture(lockData)]);

    const status = await getLockStatus(server.createClient(), "2026-10-12");

    assert.equal(status.canLock, false);
    assert.equal(status.blockers.length, 1);
    assert.equal(status.blockers[0].blocking, true);
    assert.match(status.blockers[0].message, /less registered time than scheduled/);
  });
});

describe("lockWeek", () => {
  const lockWeekFixture = loadFixture("lock-week");

  function lockedData(): Fixture {
    const body = lockData.responseBody as { rows: Record<string, unknown>[] };
    return { ...lockData, responseBody: { ...body, rows: [{ ...body.rows[0], attestlevel: 1 }] } };
  }

  it("sends the same body as the web UI for an open week without blockers", async () => {
    const server = new FakeMilltime([
      serveFixture(loadFixture("lock-check")),
      serveFixture(lockData),
      serveFixture(lockWeekFixture),
    ]);

    await lockWeek(server.createClient(), "2026-10-07");

    const post = server.apiRequests.find((r) => r.method === "POST");
    assert.deepEqual(post?.body, lockWeekFixture.requestBody);
  });

  it("plans the lock without sending it", async () => {
    const server = new FakeMilltime([serveFixture(loadFixture("lock-check")), serveFixture(lockData)]);

    const plan = await planLockWeek(server.createClient(), "2026-10-07");

    assert.ok(server.apiRequests.every((r) => r.method === "GET"));
    assert.equal(plan.summary, "Lock week 41 (2026-10-05 – 2026-10-11): 40h reported. This cannot be undone.");
  });

  it("refuses a week with blockers without sending", async () => {
    const server = new FakeMilltime([serveFixture(loadFixture("lock-check-blocked")), serveFixture(lockData)]);

    await assert.rejects(planLockWeek(server.createClient(), "2026-10-12"), /less registered time than scheduled/);
    assert.ok(server.apiRequests.every((r) => r.method === "GET"));
  });

  it("refuses a week that is already locked", async () => {
    const server = new FakeMilltime([serveFixture(loadFixture("lock-check")), serveFixture(lockedData())]);

    await assert.rejects(planLockWeek(server.createClient(), "2026-10-07"), /already locked/);
  });
});
