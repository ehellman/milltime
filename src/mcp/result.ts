import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MilltimeApiError, MilltimeHttpError, MilltimeNotLoggedInError } from "../types.ts";

export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Turns thrown errors into tool errors the model can relay or act on. */
export async function handleErrors(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    return errorResult(errorMessage(error));
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof MilltimeNotLoggedInError) {
    return 'Not logged in to Milltime. Ask the user to run "milltime auth login" in a terminal, then try again.';
  }
  if (error instanceof MilltimeApiError || error instanceof MilltimeHttpError) {
    return `Milltime error: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
