import { describe, expect, it } from "vitest";
import {
  CONTROLS,
  DEFAULT_THRESHOLDS,
  evaluateTrace,
  parseTrace,
  type AuditThresholds,
  type ControlId,
  type ControlResult,
} from "@/lib/audit";

function evaluate(source: unknown, thresholds: AuditThresholds = DEFAULT_THRESHOLDS) {
  const results = evaluateTrace(parseTrace(source), thresholds);
  return Object.fromEntries(results.map((result) => [result.id, result])) as Record<
    ControlId,
    ControlResult
  >;
}

function steps(count: number, build: (index: number) => Record<string, unknown>) {
  return { steps: Array.from({ length: count }, (_unused, index) => build(index)) };
}

const measuredSteps = (result: ControlResult) =>
  result.evidence.filter((ref) => ref.role === "measured").map((ref) => ref.step);
const missingSteps = (result: ControlResult) =>
  result.evidence.filter((ref) => ref.role === "missing").map((ref) => ref.step);

const ZERO_BAR: AuditThresholds = {
  traceabilityMin: 0,
  versioningMin: 0,
  hallucinationMax: 100,
  oversightMin: 0,
  groundednessMin: 0,
};

describe("control rules are declarative", () => {
  it("defines the four controls in a stable order with unique ids", () => {
    expect(CONTROLS.map((rule) => rule.id)).toEqual([
      "traceability",
      "versioning",
      "hallucinations",
      "oversight",
    ]);
  });

  it("gives every rule a description, a NIST AI RMF mapping and a check function", () => {
    for (const rule of CONTROLS) {
      expect(rule.name.length).toBeGreaterThan(0);
      expect(rule.description.length).toBeGreaterThan(20);
      expect(rule.framework.framework).toBe("NIST AI RMF 1.0");
      expect(rule.framework.subcategory).toMatch(/^(GOVERN|MAP|MEASURE|MANAGE) \d+\.\d+$/);
      expect(rule.framework.rationale.length).toBeGreaterThan(20);
      expect(typeof rule.check).toBe("function");
    }
  });

  it("only ever returns pass, fail or not_evidenced", () => {
    const results = evaluateTrace(parseTrace(steps(3, (i) => ({ step_id: `s${i}` }))));
    for (const result of results) {
      expect(["pass", "fail", "not_evidenced"]).toContain(result.status);
    }
  });
});

describe("missing data is never a pass", () => {
  it("returns not_evidenced for every control when the trace has no steps, even at zero bars", () => {
    const results = evaluateTrace(parseTrace({ steps: [] }), ZERO_BAR);
    expect(results.map((result) => result.status)).toEqual([
      "not_evidenced",
      "not_evidenced",
      "not_evidenced",
      "not_evidenced",
    ]);
    expect(results.every((result) => result.measured === null)).toBe(true);
  });

  it("returns not_evidenced for every control when steps carry no recognised fields", () => {
    const results = evaluateTrace(
      parseTrace(steps(5, (i) => ({ note: `free text ${i}` }))),
      ZERO_BAR,
    );
    expect(results.map((result) => result.status)).toEqual([
      "not_evidenced",
      "not_evidenced",
      "not_evidenced",
      "not_evidenced",
    ]);
  });

  it("treats null and empty-string values as missing, not recorded", () => {
    const result = evaluate(
      steps(3, () => ({ step_id: null, model_version: "", human_review: null })),
      ZERO_BAR,
    );
    expect(result.traceability.status).toBe("not_evidenced");
    expect(result.versioning.status).toBe("not_evidenced");
    expect(result.oversight.status).toBe("not_evidenced");
  });
});

describe("traceability (NIST AI RMF MEASURE 2.8)", () => {
  it("passes when every step has an ID and references each step", () => {
    const result = evaluate(steps(4, (i) => ({ step_id: `step-${i}` }))).traceability;
    expect(result.status).toBe("pass");
    expect(result.measured).toBe(100);
    expect(measuredSteps(result)).toEqual([0, 1, 2, 3]);
    expect(result.evidence[0]).toMatchObject({
      step: 0,
      stepId: "step-0",
      path: "$.steps[0].step_id",
      role: "measured",
    });
  });

  it("accepts a parseable timestamp in place of an ID", () => {
    const result = evaluate(steps(2, () => ({ timestamp: "2026-11-18T09:00:00Z" }))).traceability;
    expect(result.status).toBe("pass");
    expect(result.evidence.map((ref) => ref.path)).toEqual([
      "$.steps[0].timestamp",
      "$.steps[1].timestamp",
    ]);
  });

  it("fails below the threshold and references the exact untraced steps", () => {
    const result = evaluate(steps(10, (i) => (i < 7 ? { step_id: `s${i}` } : {}))).traceability;
    expect(result.status).toBe("fail");
    expect(result.measured).toBe(70);
    expect(missingSteps(result)).toEqual([7, 8, 9]);
    expect(result.evidence.find((ref) => ref.step === 7)).toMatchObject({
      path: "$.steps[7]",
      stepId: null,
      role: "missing",
    });
  });

  it("passes exactly at the threshold boundary", () => {
    const result = evaluate(steps(20, (i) => (i < 19 ? { step_id: `s${i}` } : {}))).traceability;
    expect(result.measured).toBe(95);
    expect(result.status).toBe("pass");
  });

  it("fails on recorded but unusable identifiers instead of treating them as missing", () => {
    const result = evaluate([{ event_id: false, timestamp: "unknown" }]).traceability;
    expect(result.status).toBe("fail");
    expect(result.measured).toBe(0);
    expect(measuredSteps(result)).toEqual([]);
    expect(missingSteps(result)).toEqual([0]);
  });
});

describe("versioning (NIST AI RMF MANAGE 4.1)", () => {
  it("passes when every step records a model version", () => {
    const result = evaluate(steps(3, () => ({ model_version: "agent-v3.2" }))).versioning;
    expect(result.status).toBe("pass");
    expect(result.evidence.map((ref) => ref.path)).toEqual([
      "$.steps[0].model_version",
      "$.steps[1].model_version",
      "$.steps[2].model_version",
    ]);
  });

  it("recognises a version nested inside step metadata", () => {
    const result = evaluate(steps(1, () => ({ metadata: { agentVersion: "1.4.0" } }))).versioning;
    expect(result.status).toBe("pass");
    expect(result.evidence[0]?.path).toBe("$.steps[0].metadata.agentVersion");
  });

  it("fails below the threshold and references the unversioned steps", () => {
    const result = evaluate(
      steps(10, (i) => (i < 8 ? { model_version: "agent-v3.2" } : { step_id: `s${i}` })),
    ).versioning;
    expect(result.status).toBe("fail");
    expect(result.measured).toBe(80);
    expect(missingSteps(result)).toEqual([8, 9]);
  });

  it("fails on placeholder versions such as 'latest' or 'unversioned'", () => {
    const result = evaluate([
      { model_version: "latest" },
      { model_version: "unversioned" },
    ]).versioning;
    expect(result.status).toBe("fail");
    expect(result.measured).toBe(0);
  });

  it("is not_evidenced when no step records any version field", () => {
    const result = evaluate(
      steps(4, (i) => ({ step_id: `s${i}` })),
      ZERO_BAR,
    ).versioning;
    expect(result.status).toBe("not_evidenced");
    expect(result.measured).toBeNull();
    expect(missingSteps(result)).toEqual([0, 1, 2, 3]);
  });
});

describe("hallucination rate (NIST AI RMF MEASURE 2.5)", () => {
  it("passes when every step is labelled and none hallucinated", () => {
    const result = evaluate(steps(10, () => ({ is_hallucination: false }))).hallucinations;
    expect(result.status).toBe("pass");
    expect(result.measured).toBe(0);
    expect(measuredSteps(result)).toHaveLength(10);
  });

  it("fails above the maximum and references the labelled steps", () => {
    const result = evaluate(steps(10, (i) => ({ is_hallucination: i < 2 }))).hallucinations;
    expect(result.status).toBe("fail");
    expect(result.measured).toBe(20);
    expect(measuredSteps(result)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("passes exactly at the maximum", () => {
    const result = evaluate(steps(20, (i) => ({ is_hallucination: i === 0 }))).hallucinations;
    expect(result.measured).toBe(5);
    expect(result.status).toBe("pass");
  });

  it("is not_evidenced when only some steps are labelled, even with a 100% maximum", () => {
    const result = evaluate(
      steps(4, (i) => (i < 2 ? { is_hallucination: false } : { step_id: `s${i}` })),
      ZERO_BAR,
    ).hallucinations;
    expect(result.status).toBe("not_evidenced");
    expect(result.measured).toBeNull();
    expect(missingSteps(result)).toEqual([2, 3]);
  });

  it("is not_evidenced when no step is labelled", () => {
    const result = evaluate(
      steps(3, (i) => ({ step_id: `s${i}` })),
      ZERO_BAR,
    ).hallucinations;
    expect(result.status).toBe("not_evidenced");
    expect(result.message).toMatch(/will not invent/);
  });

  it("uses a run-level rate (fraction) and references it as run evidence", () => {
    const result = evaluate({
      hallucination_rate: 0.02,
      steps: [{ step_id: "a" }],
    }).hallucinations;
    expect(result.status).toBe("pass");
    expect(result.measured).toBe(2);
    expect(result.evidence).toEqual([
      { step: null, stepId: null, path: "$.hallucination_rate", role: "measured" },
    ]);
  });

  it("averages per-step rates only when every step has one", () => {
    const result = evaluate({
      steps: [{ hallucination_rate_pct: 2 }, { hallucination_rate_pct: 4 }],
    }).hallucinations;
    expect(result.measured).toBe(3);
    expect(result.status).toBe("pass");
  });

  it("ignores out-of-range rates rather than guessing", () => {
    const result = evaluate({ hallucination_rate: 250, steps: [{ step_id: "a" }] }).hallucinations;
    expect(result.status).toBe("not_evidenced");
  });
});

describe("human oversight (NIST AI RMF MAP 3.5)", () => {
  it("passes when the share of reviewed steps meets the minimum", () => {
    const result = evaluate(steps(10, (i) => (i < 2 ? { human_review: true } : {}))).oversight;
    expect(result.status).toBe("pass");
    expect(result.measured).toBe(20);
    expect(measuredSteps(result)).toEqual([0, 1]);
  });

  it("fails when review is recorded as not having happened", () => {
    const result = evaluate(steps(5, () => ({ human_review: false }))).oversight;
    expect(result.status).toBe("fail");
    expect(result.measured).toBe(0);
    expect(missingSteps(result)).toEqual([0, 1, 2, 3, 4]);
  });

  it("reads review_status values and does not count pending reviews", () => {
    const result = evaluate([
      { review_status: "approved" },
      { review_status: "pending" },
      { approved_by: "reviewer-7" },
      { review_status: "pending" },
    ]).oversight;
    expect(result.measured).toBe(50);
    expect(measuredSteps(result)).toEqual([0, 2]);
  });

  it("is not_evidenced when no step records any oversight field, even at a 0% minimum", () => {
    const result = evaluate(
      steps(10, (i) => ({ step_id: `s${i}` })),
      ZERO_BAR,
    ).oversight;
    expect(result.status).toBe("not_evidenced");
    expect(result.measured).toBeNull();
  });
});

describe("thresholds", () => {
  it("re-scores every control when thresholds change", () => {
    const trace = steps(20, (i) => ({
      ...(i < 18 ? { step_id: `s${i}` } : {}),
      ...(i < 17 ? { model_version: "agent-v3" } : {}),
      is_hallucination: i < 2,
      ...(i < 1 ? { human_review: true } : {}),
    }));
    const results = evaluateTrace(parseTrace(trace), {
      traceabilityMin: 90,
      versioningMin: 80,
      hallucinationMax: 10,
      oversightMin: 5,
      groundednessMin: 90,
    });
    expect(results.map((r) => r.status)).toEqual(["pass", "pass", "pass", "pass"]);
    expect(results.map((r) => r.measured)).toEqual([90, 85, 10, 5]);
    expect(results.map((r) => r.threshold)).toEqual([90, 80, 10, 5]);
  });
});
