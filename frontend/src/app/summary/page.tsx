import type { Metadata } from "next";
import SummaryView from "@unep/views/SummaryView";

export const metadata: Metadata = {
  title: "AI Summary — Environment Knowledge",
};

export default function Page() {
  return <SummaryView />;
}
