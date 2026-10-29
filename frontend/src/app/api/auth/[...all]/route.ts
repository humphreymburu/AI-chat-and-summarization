import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@unep/lib/auth";

export const { GET, POST } = toNextJsHandler(auth);
