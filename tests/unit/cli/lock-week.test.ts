import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../src/cli/main.ts";
import { FakeMilltime, loadFixture, serveFixture } from "../../support/fake-milltime.ts";
import { captureCli, savedLogin } from "../../support/cli.ts";

async function run(fixtures: string[], ...argv: string[]) {
  const server = new FakeMilltime(fixtures.map((name) => serveFixture(loadFixture(name))));
  const cli = captureCli({ server, login: savedLogin() });
  const code = await main(argv, cli.ctx);
  const posts = server.apiRequests.filter((r) => r.method !== "GET");
  return { code, out: cli.stdout.join("\n"), err: cli.stderr.join("\n"), posts };
}

const OPEN_WEEK = ["lock-check", "lock-data", "lock-week"];

describe("lock week", () => {
  it("only shows the plan without --yes", async () => {
    const { code, out, posts } = await run(OPEN_WEEK, "lock", "week", "2026-W41");

    assert.equal(code, 0);
    assert.equal(posts.length, 0);
    assert.match(out, /^Dry run, nothing sent: Lock week 41 \(2026-10-05 – 2026-10-11\): .* This cannot be undone\.\nPOST /);
    assert.match(out, /Run again with --yes to lock the week\.$/);
  });

  it("locks the week with --yes, sending the web UI's body", async () => {
    const { code, posts } = await run(OPEN_WEEK, "lock", "week", "2026-W41", "--yes");

    assert.equal(code, 0);
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body, loadFixture("lock-week").requestBody);
  });

  it("does not send with --yes --dry-run", async () => {
    const { posts } = await run(OPEN_WEEK, "lock", "week", "2026-W41", "--yes", "--dry-run");
    assert.equal(posts.length, 0);
  });

  it("fails on a blocked week without sending, even with --yes", async () => {
    const { code, err, posts } = await run(["lock-check-blocked", "lock-data", "lock-week"], "lock", "week", "w42", "--yes");

    assert.equal(code, 1);
    assert.equal(posts.length, 0);
    assert.match(err, /^Error: Cannot lock week 42 .*less registered time than scheduled/);
  });

  it("requires the week to be named", async () => {
    const { code, posts } = await run(OPEN_WEEK, "lock", "week", "--yes");

    assert.equal(code, 2);
    assert.equal(posts.length, 0);
  });
});
