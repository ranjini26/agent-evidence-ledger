import { describe, expect, it } from "vitest";
import { TRACE_SCHEMA_ID, formatTracePath, parseTrace } from "@/lib/audit";

describe("parseTrace", () => {
  it("reads the canonical agentledger.trace.v1 shape", () => {
    const trace = parseTrace({
      schema: TRACE_SCHEMA_ID,
      run_id: "run-1",
      steps: [{ step_id: "a" }, { step_id: "b" }],
    });
    expect(trace.steps.map((step) => [step.index, step.path, step.label, step.stepId])).toEqual([
      [0, "$.steps[0]", "Step 1", "a"],
      [1, "$.steps[1]", "Step 2", "b"],
    ]);
  });

  it("accepts a bare array of steps", () => {
    const trace = parseTrace([{ step_id: "a" }]);
    expect(trace.steps[0]).toMatchObject({ path: "$[0]", label: "Entry 1", stepId: "a" });
  });

  it("accepts legacy list names and containers", () => {
    expect(parseTrace({ events: [{}] }).steps[0]?.path).toBe("$.events[0]");
    expect(parseTrace({ run: { spans: [{}, {}] } }).steps.map((step) => step.path)).toEqual([
      "$.run.spans[0]",
      "$.run.spans[1]",
    ]);
  });

  it("treats an object without a step list as a single run-metadata step", () => {
    const trace = parseTrace({ run_id: "r", model_version: "v1" });
    expect(trace.steps).toHaveLength(1);
    expect(trace.steps[0]).toMatchObject({ path: "$", label: "Run metadata" });
  });

  it("returns no steps for an explicitly empty list", () => {
    expect(parseTrace({ steps: [] }).steps).toEqual([]);
  });

  it("collects run-level fields outside the step list", () => {
    const trace = parseTrace({ hallucination_rate: 0.1, steps: [{ hallucination_rate: 0.5 }] });
    expect(trace.runFields.map((field) => field.path)).toEqual(["$.hallucination_rate"]);
  });

  it("rejects scalar input", () => {
    expect(() => parseTrace("not a run log")).toThrow(
      "Upload a JSON object or an array of log entries.",
    );
  });

  it("formats trace paths for people", () => {
    expect(formatTracePath("$.steps[2].model_version")).toBe("steps › entry 3 › model_version");
    expect(formatTracePath("$")).toBe("Run metadata");
  });
});
