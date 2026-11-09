import { timingSafeEqual } from "node:crypto";

/** The environment variable holding the single-person token for local use. */
export const TOKEN_VARIABLE = "BOTT_WEB_TOKEN";
const MINIMUM_LENGTH = 16;

/**
 * The token that unlocks the web page when it runs on this machine for one person. A hosted
 * gateway never accepts it: anyone reaching it signs in with Google instead.
 */
export function localToken(
  env: Record<string, string | undefined>,
  opts: { hosted: boolean },
): string {
  if (opts.hosted) throw new Error("Hosted mode requires Google sign-in");
  const token = env[TOKEN_VARIABLE] ?? "";
  if (token.length < MINIMUM_LENGTH) {
    throw new Error(
      `Set ${TOKEN_VARIABLE} to at least ${MINIMUM_LENGTH} characters for the web page`,
    );
  }
  return token;
}

/** Whether an Authorization header carries exactly this token, compared in constant time. */
export function bearerAllowed(header: string | null | undefined, token: string): boolean {
  const sent = Buffer.from(header ?? "", "utf8");
  const expected = Buffer.from(`Bearer ${token}`, "utf8");
  return sent.length === expected.length && timingSafeEqual(sent, expected);
}
