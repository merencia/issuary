/**
 * Error thrown by the auth (device flow) module for expected, user-facing
 * failures: a missing client id, a denied or expired device-flow grant, or an
 * unexpected OAuth response.
 *
 * Callers should catch this to print a friendly, actionable message instead of a
 * stack trace. Messages never contain the resulting access token.
 */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}
