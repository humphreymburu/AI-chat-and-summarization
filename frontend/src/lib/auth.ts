import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";

import { pool } from "./db";

// Reads BETTER_AUTH_SECRET and BETTER_AUTH_URL from the environment.
export const auth = betterAuth({
  appName: "EcoBuddy",
  database: pool,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },
  // Must stay last: lets server actions set auth cookies.
  plugins: [nextCookies()],
});

export type Session = typeof auth.$Infer.Session;
