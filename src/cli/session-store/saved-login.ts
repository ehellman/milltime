import { z } from "zod";
import type { StoredSession } from "../../client.ts";

/** A logged-in session and where it belongs. Never contains the password. */
export interface SavedLogin {
  baseUrl: string;
  instanceId: string;
  username: string;
  session: StoredSession;
}

const SavedLoginSchema = z.object({
  baseUrl: z.string(),
  instanceId: z.string(),
  username: z.string(),
  session: z.object({
    token: z.string(),
    csrfToken: z.string(),
    instanceCookie: z.string().nullable(),
    userId: z.string(),
    expiresAt: z.number(),
  }),
});

/** Parses a stored secret. Anything unreadable counts as not logged in. */
export function parseSavedLogin(text: string): SavedLogin | null {
  try {
    const parsed = SavedLoginSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
