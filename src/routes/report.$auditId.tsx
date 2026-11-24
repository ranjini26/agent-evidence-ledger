import { createFileRoute } from "@tanstack/react-router";
import { ReportPage } from "@/components/agent-ledger/ledger-app";

export const Route = createFileRoute("/report/$auditId")({
  head: () => ({
    meta: [
      { title: "Printable audit report — AgentLedger" },
      {
        name: "description",
        content:
          "Open your printable AI agent run audit report with its overall opinion, thresholds, and evidence limitations.",
      },
      { property: "og:title", content: "Printable audit report — AgentLedger" },
      {
        property: "og:description",
        content: "Print or save your evidence-linked agent run audit report.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ReportRoute,
});

function ReportRoute() {
  const { auditId } = Route.useParams();
  return <ReportPage auditId={auditId} />;
}
