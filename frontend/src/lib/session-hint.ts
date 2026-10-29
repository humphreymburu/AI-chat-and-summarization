import { getSessionCookie } from "better-auth/cookies";
import { headers } from "next/headers";

/**
 * Whether the request carries a login cookie. No cookie means a guest for
 * certain; a cookie means probably signed in (it may have expired), so the
 * page shows the signed-in layout as a skeleton until the session confirms.
 */
export async function hasSessionCookie() {
  return Boolean(getSessionCookie(await headers()));
}
