import { createFileRoute } from "@tanstack/react-router";
import { FindingsPage } from "@/components/agent-ledger/ledger-app";

export const Route = createFileRoute("/findings/$auditId")({
  head: () => ({
    meta: [
      { title: "Audit findings — AgentLedger" },
      { name: "description", content: "Review AgentLedger control findings beside the precise original JSON run log entries." },
      { property: "og:title", content: "Audit findings — AgentLedger" },
      { property: "og:description", content: "Inspect source-linked findings and original AI agent run entries." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: FindingsRoute,
});

function FindingsRoute() {
  const { auditId } = Route.useParams();
  return <FindingsPage auditId={auditId}/>;
}