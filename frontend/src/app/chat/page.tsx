import type { Metadata } from "next";

import { hasSessionCookie } from "@unep/lib/session-hint";
import ChatView from "@unep/views/ChatView";

export const metadata: Metadata = {
  title: "Research Chat — Environment Knowledge",
};

export default async function Page() {
  return <ChatView signedIn={await hasSessionCookie()} />;
}
