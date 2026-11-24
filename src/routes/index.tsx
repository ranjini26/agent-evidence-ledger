import { createFileRoute } from "@tanstack/react-router";
import { DashboardPage } from "@/components/agent-ledger/ledger-app";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "AgentLedger — AI agent run audits" },
      {
        name: "description",
        content:
          "Review AI agent run logs against four evidence-linked controls, set your own thresholds, and produce a printable audit opinion.",
      },
      { property: "og:title", content: "AgentLedger — AI agent run audits" },
      {
        property: "og:description",
        content: "A private workspace for evidence-based AI agent run reviews.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DashboardPage,
});
