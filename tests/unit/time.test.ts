import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { FakeMilltime, filterOf, loadFixture, rowsOf, serveFixture } from "../support/fake-milltime.ts";
import { listProjects } from "../../src/endpoints/projects.ts";
import {
  deleteTimeRow,
  planDeleteTimeRow,
  planReportTime,
  planUpdateTimeRow,
  reportTime,
  updateTimeRow,
} from "../../src/endpoints/time.ts";

const createFixture = loadFixture("time-create");
const calendarFixture = loadFixture("calendar-week-before-note");
const noteFixture = loadFixture("time-update-note");
const createBody = createFixture.requestBody as Record<string, string>;
const noteBody = noteFixture.requestBody as Record<string, string>;

// The fixtures are from 2026-10-12 (ISO week 42); the UI sends the current week.
beforeEach(() => mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-12T10:00:00Z") }));
afterEach(() => mock.timers.reset());

async function sampleActivity() {
  const server = new FakeMilltime([serveFixture(loadFixture("project-favorite"))]);
  const projects = await listProjects(server.createClient());
  const activity = projects
    .flatMap((p) => p.activities)
    .find((a) => a.id === createBody.activity && a.project.id === createBody.projectid);
  assert.ok(activity, "the sample activity should be in the favorites fixture");
  return activity;
}

function withoutKey(body: unknown, key: string): Record<string, unknown> {
  const { [key]: _, ...rest } = body as Record<string, unknown>;
  return rest;
}

describe("reportTime", () => {
  it("sends the same body as the web UI for an activity from listProjects", async () => {
    const activity = await sampleActivity();
    const server = new FakeMilltime([serveFixture(calendarFixture), serveFixture(createFixture)], {
      userId: createBody.userid,
    });

    const row = await reportTime(server.createClient(), { activity, date: "2026-10-10", hours: 5 });

    const [read, write] = server.apiRequests;
    assert.deepEqual(filterOf(read), [["fromDate", "=", "2026-10-10"], ["toDate", "=", "2026-10-10"]]);
    assert.deepEqual(write.body, createFixture.requestBody);
    assert.equal(row.id, rowsOf(createFixture)[0].projectregistrationid);
    assert.equal(row.hours, 5);
    assert.equal(row.timeType, "TRAVELTIME1");
  });

  for (const [fixtureName, absenceType, date, hours] of [
    ["time-create-sick-half-day", "SICK", "2026-10-20", 4],
    ["time-create-vacation", "VACATION", "2026-10-19", 1],
  ] as const) {
    it(`reports ${absenceType} absence like the web UI`, async () => {
      mock.timers.setTime(new Date("2026-10-22T10:00:00Z").getTime());
      const fixture = loadFixture(fixtureName);
      const body = fixture.requestBody as Record<string, string>;
      const activity = {
        id: body.activity,
        name: body.activityname,
        project: { id: body.projectid, name: body.projectname },
        taskId: body.planningtaskid,
        timeType: "NORMALTIME",
        absenceType,
        requiresNote: false,
      };
      const server = new FakeMilltime([serveFixture(calendarFixture), serveFixture(fixture)], { userId: body.userid });

      const row = await reportTime(server.createClient(), { activity, date, hours });

      assert.deepEqual(server.apiRequests[1].body, fixture.requestBody);
      assert.equal(row.absenceType, absenceType);
      assert.equal(row.hours, hours);
    });
  }

  it("refuses an activity that requires a note when there is none", async () => {
    const activity = { ...(await sampleActivity()), requiresNote: true };
    const server = new FakeMilltime([serveFixture(calendarFixture)]);

    await assert.rejects(reportTime(server.createClient(), { activity, date: "2026-10-10", hours: 1 }), /requires a note/);
    assert.equal(server.apiRequests.length, 0);
  });

  it("refuses a locked day without sending the row", async () => {
    const activity = await sampleActivity();
    const server = new FakeMilltime([serveFixture(loadFixture("user-calendar"))]);

    await assert.rejects(reportTime(server.createClient(), { activity, date: "2026-09-15", hours: 1 }), /locked/);
    assert.ok(server.apiRequests.every((r) => r.method === "GET"));
  });
});

describe("updateTimeRow", () => {
  const row = { id: noteBody.projectregistrationid, date: noteBody.regday };

  it("re-reads the row and sends the same body as the web UI when adding a note", async () => {
    const server = new FakeMilltime([serveFixture(calendarFixture), serveFixture(noteFixture)]);

    const saved = await updateTimeRow(server.createClient(), row, { note: noteBody.usernote });

    const [read, write] = server.apiRequests;
    assert.deepEqual(filterOf(read), [["fromDate", "=", row.date], ["toDate", "=", row.date]]);
    // The UI sent a different activity name than the stored row has; the server keys on the activity id.
    assert.deepEqual(withoutKey(write.body, "activityname"), withoutKey(noteBody, "activityname"));
    assert.deepEqual(filterOf(write), noteFixture.query.filter);
    assert.equal(saved.note, noteBody.usernote);
  });

  it("formats changed hours like the web UI", async () => {
    const server = new FakeMilltime([serveFixture(calendarFixture), serveFixture(noteFixture)]);

    await updateTimeRow(server.createClient(), row, { hours: 1.5 });

    const body = server.apiRequests[1].body as Record<string, unknown>;
    assert.equal(body.projtime, "1.50");
    assert.equal(body.inputtime, "1.50");
  });

  it("refuses locked rows without sending an update", async () => {
    const calendar = loadFixture("user-calendar");
    const locked = rowsOf(calendar)
      .flatMap((m) => m.weeks.flatMap((w: any) => w.days.flatMap((d: any) => d.projectregistrations)))
      .find((r) => (r.attestlevel ?? 0) >= 1);
    assert.ok(locked, "fixture should contain a locked row");
    const server = new FakeMilltime([serveFixture(calendar)]);

    await assert.rejects(
      updateTimeRow(server.createClient(), { id: locked.projectregistrationid, date: locked.regday }, { hours: 1 }),
      /locked/,
    );
    assert.ok(server.apiRequests.every((r) => r.method === "GET"));
  });
});

describe("deleteTimeRow", () => {
  const deleteFixture = loadFixture("time-delete");
  const rawRows = rowsOf(calendarFixture).flatMap((m) =>
    m.weeks.flatMap((w: any) => w.days.flatMap((d: any) => d.projectregistrations)),
  );

  it("re-reads the row and deletes it by id and time type, like the web UI", async () => {
    const raw = rawRows.find((r) => (r.attestlevel ?? 0) < 1);
    assert.ok(raw, "fixture should contain an unlocked row");
    const server = new FakeMilltime([serveFixture(calendarFixture), serveFixture(deleteFixture)]);

    await deleteTimeRow(server.createClient(), { id: raw.projectregistrationid, date: raw.regday });

    const [read, remove] = server.apiRequests;
    assert.deepEqual(filterOf(read), [["fromDate", "=", raw.regday], ["toDate", "=", raw.regday]]);
    assert.equal(remove.method, "DELETE");
    assert.equal(remove.body, undefined);
    const timeType = raw.timedistributiontype ?? "NORMALTIME";
    assert.deepEqual(filterOf(remove), [["ProjectRegistrationId", "=", raw.projectregistrationid], ["TimeDistributionType", "=", timeType]]);
    // Same filter fields, in the same order, as the fixture request.
    const expected = deleteFixture.query.filter as string[][];
    assert.deepEqual((filterOf(remove) as string[][]).map(([field]) => field), expected.map(([field]) => field));
  });

  it("refuses locked rows without deleting", async () => {
    const calendar = loadFixture("user-calendar");
    const locked = rowsOf(calendar)
      .flatMap((m) => m.weeks.flatMap((w: any) => w.days.flatMap((d: any) => d.projectregistrations)))
      .find((r) => (r.attestlevel ?? 0) >= 1);
    const server = new FakeMilltime([serveFixture(calendar)]);

    await assert.rejects(
      deleteTimeRow(server.createClient(), { id: locked.projectregistrationid, date: locked.regday }),
      /locked/,
    );
    assert.ok(server.apiRequests.every((r) => r.method === "GET"));
  });
});

describe("planned time writes", () => {
  const noteRow = { id: noteBody.projectregistrationid, date: noteBody.regday };

  it("plans a report without sending it", async () => {
    const activity = await sampleActivity();
    const server = new FakeMilltime([serveFixture(calendarFixture)], { userId: createBody.userid });

    const plan = await planReportTime(server.createClient(), { activity, date: "2026-10-10", hours: 5 });

    assert.ok(server.apiRequests.every((r) => r.method === "GET"));
    assert.equal(plan.method, "POST");
    assert.deepEqual(plan.body, createFixture.requestBody);
    assert.equal(plan.summary, `Report 5h ${activity.name} (${activity.project.name}) on 2026-10-10`);
  });

  it("shows the note in the summary", async () => {
    const activity = await sampleActivity();
    const server = new FakeMilltime([serveFixture(calendarFixture)], { userId: createBody.userid });

    const plan = await planReportTime(server.createClient(), { activity, date: "2026-10-10", hours: 5, note: "Planning" });

    assert.match(plan.summary, /on 2026-10-10, note "Planning"$/);
  });

  it("plans an update and describes the change", async () => {
    const server = new FakeMilltime([serveFixture(calendarFixture)]);

    const plan = await planUpdateTimeRow(server.createClient(), noteRow, { hours: 1.5 });

    assert.ok(server.apiRequests.every((r) => r.method === "GET"));
    assert.equal(plan.method, "PUT");
    assert.match(plan.summary, /^Update .* on 2026-10-05: hours \d+(\.\d+)?h → 1\.5h$/);
  });

  it("plans a delete without sending it", async () => {
    const server = new FakeMilltime([serveFixture(calendarFixture)]);

    const plan = await planDeleteTimeRow(server.createClient(), noteRow);

    assert.ok(server.apiRequests.every((r) => r.method === "GET"));
    assert.equal(plan.method, "DELETE");
    assert.equal(plan.body, undefined);
    assert.match(plan.summary, /^Delete .* on 2026-10-05$/);
  });
});
