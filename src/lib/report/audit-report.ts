/**
 * A single, format-neutral model of an exported audit report. Markdown and PDF
 * are both rendered from it, so the two exports always say the same thing.
 * Pure: every value comes from the stored run, its results and the ledger.
 */
import {
  formatPercentage,
  type AuditThresholds,
  type ControlResult,
  type ControlStatus,
  type EvidenceRef,
  type LedgerRecord,
  type LedgerVerification,
} from "@/lib/audit";

export type ReportBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "table"; rows: [string, string][] };

export interface AuditReport {
  title: string;
  blocks: ReportBlock[];
}

export interface AuditReportInput {
  run: { id: string; name: string; sourceFilename: string; createdAt: string; eventCount: number };
  results: ControlResult[];
  thresholds: AuditThresholds;
  opinion: { title: string; explanation: string };
  /** Labels for trace steps, used to name evidence. */
  steps: { index: number; label: string; stepId: string | null }[];
  ledger: {
    record: Pick<
      LedgerRecord,
      "index" | "hash" | "previousHash" | "engineVersion" | "recordedAt"
    > | null;
    verification: LedgerVerification | null;
    /** Whether the stored audit still equals its ledger record (from crossCheckRuns). */
    runCheck?: "matches" | "modified_since_recorded" | "not_recorded";
  };
  generatedAt: string;
}

const STATUS_LABEL: Record<ControlStatus, string> = {
  pass: "Pass",
  fail: "Fail",
  not_evidenced: "Not evidenced",
};

export const REPORT_LIMITATIONS = [
  "This report is an internal evidence summary, not a security assessment, factual truth guarantee, independent verification, legal opinion, or formal compliance certification.",
  "The sample is limited to the JSON entries supplied. Fields can be incomplete, mislabeled or inaccurate.",
  "“Not evidenced” means the source did not provide a usable measurement; it does not mean the control passed or failed in reality.",
  "Framework mappings (NIST AI RMF 1.0) are AgentLedger's interpretation and should be checked against the framework text.",
];

function stepName(
  ref: Pick<EvidenceRef, "step" | "stepId">,
  steps: AuditReportInput["steps"],
): string {
  if (ref.step === null) return "Run level";
  const step = steps.find((candidate) => candidate.index === ref.step);
  const label = step?.label ?? `Step ${ref.step + 1}`;
  const id = ref.stepId ?? step?.stepId ?? null;
  return id ? `${label} (${id})` : label;
}

function controlBlocks(result: ControlResult, steps: AuditReportInput["steps"]): ReportBlock[] {
  const blocks: ReportBlock[] = [
    { kind: "heading", level: 2, text: `${result.name}: ${STATUS_LABEL[result.status]}` },
    {
      kind: "table",
      rows: [
        ["Result", STATUS_LABEL[result.status]],
        ["Measured", formatPercentage(result.measured)],
        ["Threshold", `${result.direction === "minimum" ? "≥" : "≤"} ${result.threshold}%`],
        ["Summary", result.summary],
        ["Finding", result.message],
      ],
    },
    { kind: "heading", level: 3, text: "Method" },
    { kind: "paragraph", text: result.description },
    {
      kind: "paragraph",
      text: `Framework: ${result.framework.framework} ${result.framework.subcategory} (${result.framework.function}). ${result.framework.rationale}`,
    },
  ];
  if (result.method) {
    blocks.push({
      kind: "paragraph",
      text: `Judge: ${result.method.name}. Model: ${result.method.model ?? "not run (no API key)"}. Prompt version: ${result.method.promptVersion}.`,
    });
  }

  blocks.push({ kind: "heading", level: 3, text: "Cited evidence" });
  blocks.push(
    result.evidence.length === 0
      ? { kind: "paragraph", text: "No evidence references." }
      : {
          kind: "list",
          items: result.evidence.map(
            (ref) =>
              `${stepName(ref, steps)}, ${ref.role === "measured" ? "measured" : "missing value"}: ${ref.path}`,
          ),
        },
  );

  if (result.answers && result.answers.length > 0) {
    blocks.push({ kind: "heading", level: 3, text: "Claims checked" });
    const items = result.answers.flatMap((answer) => {
      const where = stepName(answer, steps);
      if (answer.error) return [`${where}: not judged (${answer.error})`];
      if (answer.verdict === "not_evidenced") return [`${where}: not judged`];
      if (answer.claims.length === 0) return [`${where}: no factual claims`];
      return answer.claims.map((claim) => {
        const cites = claim.supportingSteps
          .map((step) => stepName({ step, stepId: null }, steps))
          .join(", ");
        return `${where}: ${claim.verdict}: ${claim.claim}${cites ? ` [${cites}]` : ""}. ${claim.explanation}`.trim();
      });
    });
    blocks.push({ kind: "list", items });
  }
  return blocks;
}

export function buildAuditReport(input: AuditReportInput): AuditReport {
  const { run, results, thresholds, opinion, ledger } = input;
  const count = (status: ControlStatus) =>
    results.filter((result) => result.status === status).length;
  const blocks: ReportBlock[] = [
    { kind: "heading", level: 1, text: `Audit report: ${run.name}` },
    {
      kind: "paragraph",
      text: `Exported by AgentLedger on ${input.generatedAt}. Produced on this device from the stored audit; nothing was re-scored for this export.`,
    },
    { kind: "heading", level: 2, text: "Run summary" },
    {
      kind: "table",
      rows: [
        ["Run", run.name],
        ["Source file", run.sourceFilename],
        ["Audit ID", run.id],
        ["Audited at", run.createdAt],
        ["Log entries", String(run.eventCount)],
        ["Overall opinion", opinion.title],
        [
          "Controls",
          `${count("pass")} pass, ${count("fail")} fail, ${count("not_evidenced")} not evidenced`,
        ],
      ],
    },
    { kind: "paragraph", text: opinion.explanation },
    { kind: "heading", level: 2, text: "Ledger" },
  ];

  if (ledger.record) {
    blocks.push({
      kind: "paragraph",
      text: `Ledger record #${ledger.record.index}, written ${ledger.record.recordedAt} by engine ${ledger.record.engineVersion}.`,
    });
    blocks.push({
      kind: "table",
      rows: [
        ["Record hash (SHA-256)", ledger.record.hash],
        ["Previous record hash", ledger.record.previousHash],
      ],
    });
  } else {
    blocks.push({
      kind: "paragraph",
      text: "This run is not recorded in the ledger: it was saved before the ledger existed, or recording failed.",
    });
  }
  if (ledger.record && ledger.runCheck === "modified_since_recorded") {
    const recordIndex = ledger.record.index;
    const recordBroken =
      ledger.verification?.breaks.some((item) => item.index === recordIndex) ?? false;
    blocks.push({
      kind: "paragraph",
      text: recordBroken
        ? `WARNING: this stored audit differs from ledger record #${recordIndex}, and record #${recordIndex} itself fails verification. Neither copy can be trusted as the original.`
        : `WARNING: this stored audit differs from ledger record #${recordIndex}. It was changed after it was recorded; the ledger record is the original.`,
    });
  }
  const verification = ledger.verification;
  blocks.push({
    kind: "paragraph",
    text:
      verification === null
        ? "Ledger not verified at export."
        : verification.ok
          ? `Ledger verified at export: intact, ${verification.records} record${verification.records === 1 ? "" : "s"}${verification.headHash ? `, head hash ${verification.headHash}` : ""}.`
          : `Ledger verification at export: BROKEN at record #${verification.firstBreak?.index ?? "?"}. ${verification.firstBreak?.explanation ?? ""}`.trim(),
  });

  blocks.push({ kind: "heading", level: 2, text: "Thresholds applied" });
  blocks.push({
    kind: "table",
    rows: [
      ["Traceability", `≥ ${thresholds.traceabilityMin}%`],
      ["Versioning", `≥ ${thresholds.versioningMin}%`],
      ["Hallucination rate", `≤ ${thresholds.hallucinationMax}%`],
      ["Human oversight", `≥ ${thresholds.oversightMin}%`],
      ...(results.some((result) => result.id === "groundedness")
        ? ([["Groundedness", `≥ ${thresholds.groundednessMin}%`]] as [string, string][])
        : []),
    ],
  });

  for (const result of results) blocks.push(...controlBlocks(result, input.steps));

  const unevidenced = results
    .filter((result) => result.status === "not_evidenced")
    .map((result) => result.name);
  const limitations = [...REPORT_LIMITATIONS];
  if (unevidenced.length > 0) {
    limitations.push(
      `Not evidenced in this run: ${unevidenced.join(", ")}. No conclusion is drawn for these controls.`,
    );
  }
  if (results.some((result) => result.method)) {
    limitations.push(
      "Groundedness is judged by a language model. Its claim extraction and verdicts can be wrong; agreement with human labels is measured separately (evals/groundedness).",
    );
  }
  limitations.push(
    "The ledger is a local SHA-256 hash chain. It detects edits, insertions, removals and reordering of earlier records, but not removal of the newest records or a rewrite of the whole chain, and it is not a digital signature. Keep the head hash above to compare later.",
  );
  blocks.push({ kind: "heading", level: 2, text: "Limitations" });
  blocks.push({ kind: "list", items: limitations });

  return { title: `Audit report: ${run.name}`, blocks };
}
