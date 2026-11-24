import type { AuditReport } from "./audit-report";

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function renderMarkdown(report: AuditReport): string {
  const parts = report.blocks.map((block) => {
    switch (block.kind) {
      case "heading":
        return `${"#".repeat(block.level)} ${block.text}`;
      case "paragraph":
        return block.text;
      case "list":
        return block.items.map((item) => `- ${item.replace(/\r?\n/g, " ")}`).join("\n");
      case "table":
        return [
          "| Field | Value |",
          "|---|---|",
          ...block.rows.map(([key, value]) => `| ${cell(key)} | ${cell(value)} |`),
        ].join("\n");
    }
  });
  return `${parts.join("\n\n")}\n`;
}
