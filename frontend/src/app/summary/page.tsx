import type { Metadata } from "next";

import { hasSessionCookie } from "@unep/lib/session-hint";
import SummaryView from "@unep/views/SummaryView";

export const metadata: Metadata = {
  title: "AI Summary — Environment Knowledge",
};

export default async function Page() {
  return <SummaryView signedIn={await hasSessionCookie()} />;
}
