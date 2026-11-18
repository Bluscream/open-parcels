import { z } from "zod";

/** An error whose message is safe to show to API clients. */
export class ApiError extends Error {
  override readonly name = "ApiError";

  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const errorBodySchema = z.object({
  error: z.string().describe("Stable machine-readable error code."),
  message: z.string().describe("Human-readable explanation."),
});

export const unauthorized = (): ApiError =>
  new ApiError(401, "unauthorized", "Sign in or send a valid API token.");
export const forbidden = (scope: string): ApiError =>
  new ApiError(403, "forbidden", `This needs the "${scope}" scope.`);
export const notFound = (what: string): ApiError =>
  new ApiError(404, "not_found", `${what} was not found.`);
