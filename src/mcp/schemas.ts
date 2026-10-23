import { z } from "zod";

export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const optionalDate = (description: string) =>
  date.optional().describe(`${description}; YYYY-MM-DD, default today`);

export const confirmToken = z
  .string()
  .optional()
  .describe("Leave out to get a preview. Pass the token from the preview only after the user has confirmed it.");

export const rangeInput = {
  from: date.optional().describe("First day; YYYY-MM-DD, default the first of this month"),
  to: date.optional().describe("Last day; YYYY-MM-DD, default the last of this month"),
};
