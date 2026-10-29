import type { Metadata } from "next";
import ChatView from "@unep/views/ChatView";

export const metadata: Metadata = {
  title: "Research Chat — Environment Knowledge",
};

export default function Page() {
  return <ChatView />;
}
