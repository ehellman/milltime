import { z } from "zod";

export const ApiResponseSchema = z.object({
  success: z.boolean(),
  rows: z.array(z.unknown()).optional(),
  data: z.unknown().optional(),
  errors: z.array(z.string()).optional(),
});

export type ApiResponse = z.infer<typeof ApiResponseSchema>;

export class MilltimeApiError extends Error {
  readonly status: number;
  readonly response: ApiResponse;
  constructor(status: number, response: ApiResponse) {
    super(response.errors?.length ? response.errors.join("; ") : "Milltime API returned success=false");
    this.name = "MilltimeApiError";
    this.status = status;
    this.response = response;
  }
}

export class MilltimeHttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`Milltime HTTP ${status}`);
    this.name = "MilltimeHttpError";
    this.status = status;
    this.body = body;
  }
}

/** The stored session is missing, expired or rejected, and the client may not log in by itself. */
export class MilltimeNotLoggedInError extends Error {
  constructor() {
    super("Not logged in");
    this.name = "MilltimeNotLoggedInError";
  }
}
