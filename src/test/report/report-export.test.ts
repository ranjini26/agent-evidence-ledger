import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  GROUNDEDNESS_PROMPT_VERSION,
  auditOpinion,
  evaluateGroundedness,
  evaluateRunOffline,
  parseTrace,
  type ControlResult,
  type GroundednessJudge,
} from "@/lib/audit";
import { buildAuditReport, type AuditReportInput } from "@/lib/report/audit-report";
import { renderMarkdown } from "@/lib/report/markdown";
import { renderPdf } from "@/lib/report/pdf";

const source = {
  steps: [
    { step_id: "t1", type: "tool_output", content: "Order 1042 shipped." },
    {
      step_id: "a1",
      type: "model_answer",
      model_version: "v1",
      content: "Your order shipped and arrives Friday.",
    },
  ],
};
const trace = parseTrace(source);

async function input(overrides: Partial<AuditReportInput> = {}): Promise<AuditReportInput> {
  const judge: GroundednessJudge = {
    model: "claude-opus-5-5",
    promptVersion: GROUNDEDNESS_PROMPT_VERSION,
    judge: async () => ({
      model: "claude-opus-5-5",
      judgement: {
        claims: [
          {
            claim: "Order shipped",
            verdict: "supported",
            supporting_steps: [0],
            explanation: "t1 says so",
          },
          {
            claim: "Arrives Friday",
            verdict: "unsupported",
            supporting_steps: [],
            explanation: "no ETA in t1",
          },
        ],
      },
    }),
  };
  const results: ControlResult[] = [
    ...evaluateRunOffline(trace, DEFAULT_THRESHOLDS).slice(0, 4),
    await evaluateGroundedness(trace, DEFAULT_THRESHOLDS.groundednessMin, judge),
  ];
  return {
    run: {
      id: "local-123",
      name: "Support run 42",
      sourceFilename: "run-42.json",
      createdAt: "2026-11-25T10:00:00.000Z",
      eventCount: 2,
    },
    results,
    thresholds: DEFAULT_THRESHOLDS,
    opinion: auditOpinion(results),
    steps: trace.steps.map((step) => ({
      index: step.index,
      label: step.label,
      stepId: step.stepId,
    })),
    ledger: {
      record: {
        index: 7,
        hash: "a".repeat(64),
        previousHash: "b".repeat(64),
        engineVersion: "agentledger-audit-1.0.0",
        recordedAt: "2026-11-25T10:00:01.000Z",
      },
      verification: {
        ok: true,
        records: 7,
        headHash: "a".repeat(64),
        firstBreak: null,
        breaks: [],
      },
    },
    generatedAt: "2026-11-25T12:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("Markdown export", () => {
  it("contains the run summary, every control with its result, evidence, method and limitations", async () => {
    const data = await input();
    const md = renderMarkdown(buildAuditReport(data));
    expect(md).toMatch(/^# Audit report: Support run 42/m);
    expect(md).toContain("run-42.json");
    expect(data.opinion.title).toBe("Qualified — findings require attention");
    expect(md).toContain("| Overall opinion | Qualified — findings require attention |");
    for (const name of [
      "Traceability",
      "Versioning",
      "Hallucination rate",
      "Human oversight",
      "Groundedness",
    ]) {
      expect(md).toMatch(new RegExp(`^## .*${name}`, "m"));
    }
    expect(md).toContain("$.steps[0].step_id");
    expect(md).toContain("Step 1 (t1)");
    expect(md).toContain("NIST AI RMF 1.0 MEASURE 2.8");
    expect(md).toContain("claude-opus-5-5");
    expect(md).toContain(GROUNDEDNESS_PROMPT_VERSION);
    expect(md).toContain("unsupported: Arrives Friday");
    expect(md).toMatch(/^## Limitations/m);
    expect(md).toContain("not a security assessment");
  });

  it("states the ledger record, its hash and the verification outcome", async () => {
    const md = renderMarkdown(buildAuditReport(await input()));
    expect(md).toContain("Ledger record #7");
    expect(md).toContain("a".repeat(64));
    expect(md).toContain("agentledger-audit-1.0.0");
    expect(md).toMatch(/Ledger verified .*intact/i);
  });

  it("says plainly when the run has no ledger record or the ledger is broken", async () => {
    const unrecorded = renderMarkdown(
      buildAuditReport(await input({ ledger: { record: null, verification: null } })),
    );
    expect(unrecorded).toMatch(/not recorded in the ledger/i);

    const broken = renderMarkdown(
      buildAuditReport(
        await input({
          ledger: {
            record: null,
            verification: {
              ok: false,
              records: 7,
              headHash: null,
              firstBreak: {
                index: 3,
                runId: "x",
                runName: "Run X",
                reason: "hash_mismatch",
                explanation: "The contents of record #3 changed.",
              },
              breaks: [],
            },
          },
        }),
      ),
    );
    expect(broken).toMatch(/BROKEN at record #3/);
  });

  it("warns when the stored audit no longer matches its ledger record", async () => {
    const base = await input();
    const md = renderMarkdown(
      buildAuditReport({
        ...base,
        ledger: { ...base.ledger, runCheck: "modified_since_recorded" },
      }),
    );
    expect(md).toMatch(/WARNING: this stored audit differs from ledger record #7/);
  });

  it("does not call the ledger record the original when that record itself fails verification", async () => {
    const base = await input();
    const md = renderMarkdown(
      buildAuditReport({
        ...base,
        ledger: {
          ...base.ledger,
          runCheck: "modified_since_recorded",
          verification: {
            ok: false,
            records: 7,
            headHash: null,
            firstBreak: {
              index: 7,
              runId: "local-123",
              runName: "Support run 42",
              reason: "hash_mismatch",
              explanation: "x",
            },
            breaks: [
              {
                index: 7,
                runId: "local-123",
                runName: "Support run 42",
                reason: "hash_mismatch",
                explanation: "x",
              },
            ],
          },
        },
      }),
    );
    expect(md).toMatch(/record #7 itself fails verification/);
    expect(md).not.toMatch(/the ledger record is the original/);
  });

  it("shows unmeasured values as not evidenced rather than a number", async () => {
    const md = renderMarkdown(buildAuditReport(await input()));
    expect(md).toMatch(/Hallucination rate[\s\S]*?Measured \| Not measured/);
  });
});

function pdfText(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
}

describe("PDF export", () => {
  it("produces a structurally valid PDF with a correct cross-reference table", async () => {
    const bytes = renderPdf(buildAuditReport(await input()), { title: "Audit report" });
    const text = pdfText(bytes);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(bytes.every((byte) => byte === 10 || byte === 13 || (byte >= 32 && byte < 127))).toBe(
      true,
    );

    const startxref = Number(/startxref\s+(\d+)/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");
    const xref = text.slice(startxref).split("\n");
    const count = Number(xref[1]!.split(" ")[1]);
    for (let object = 1; object < count; object++) {
      const offset = Number(xref[2 + object]!.slice(0, 10));
      expect(text.slice(offset).startsWith(`${object} 0 obj`)).toBe(true);
    }
  });

  it("contains the report text, escaping PDF special characters", async () => {
    const text = pdfText(renderPdf(buildAuditReport(await input()), { title: "Audit report" }));
    expect(text).toContain("(Traceability");
    expect(text).toContain("Groundedness");
    expect(text).toContain("\\(t1\\)");
    expect(text).toContain("Limitations");
  });

  it("paginates long reports", async () => {
    const report = buildAuditReport(await input());
    const long = {
      ...report,
      blocks: [
        ...report.blocks,
        ...Array.from({ length: 200 }, (_, i) => ({
          kind: "paragraph" as const,
          text: `Line ${i}`,
        })),
      ],
    };
    const text = pdfText(renderPdf(long, { title: "Audit report" }));
    expect(Number(/\/Count (\d+)/.exec(text)![1])).toBeGreaterThan(1);
  });

  it("makes no network calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const report = buildAuditReport(await input());
    renderMarkdown(report);
    renderPdf(report, { title: "Audit report" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
