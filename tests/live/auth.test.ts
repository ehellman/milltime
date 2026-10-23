import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLiveClient } from "./client.ts";

describe("auth", () => {
  it("logs in and obtains a session with userId", async () => {
    const client = createLiveClient();
    await client.login();
    assert.ok(client.currentUserId, "userId should be set after login");
  });
});
