import { MilltimeClient } from "../../src/client.ts";

export function createLiveClient(): MilltimeClient {
  const { MILLTIME_BASE_URL, MILLTIME_USER, MILLTIME_PASS, MILLTIME_INSTANCE_ID } = process.env;
  if (!MILLTIME_BASE_URL || !MILLTIME_USER || !MILLTIME_PASS || !MILLTIME_INSTANCE_ID) {
    throw new Error("Set MILLTIME_BASE_URL, MILLTIME_USER, MILLTIME_PASS and MILLTIME_INSTANCE_ID in .env");
  }
  return new MilltimeClient({
    baseUrl: MILLTIME_BASE_URL,
    instanceId: MILLTIME_INSTANCE_ID,
    auth: { kind: "password", username: MILLTIME_USER, password: MILLTIME_PASS },
  });
}
