import { describe, expect, it } from "vitest";
import { SAMPLE_RUNS, evaluateTrace, parseTrace } from "@/lib/audit";

describe("SAMPLE run fixtures", () => {
  it("provides the six sample scenarios", () => {
    expect(SAMPLE_RUNS.map((fixture) => fixture.id)).toEqual([
      "complete-evidence",
      "traceability-gap",
      "version-drift",
      "high-hallucination-rate",
      "oversight-gap",
      "hallucination-not-measured",
    ]);
  });

  it("labels every fixture SAMPLE, both in its name and inside the trace itself", () => {
    for (const fixture of SAMPLE_RUNS) {
      expect(fixture.label).toMatch(/^SAMPLE · /);
      expect(fixture.trace.label).toBe(fixture.label);
      expect(fixture.trace.sample).toBe(true);
      expect(fixture.trace.run_id).toBe(`sample-${fixture.id}`);
      expect(fixture.trace.steps).toHaveLength(10);
    }
  });

  it.each(SAMPLE_RUNS.map((fixture) => [fixture.label, fixture] as const))(
    "%s evaluates to its documented outcome",
    (_label, fixture) => {
      const results = evaluateTrace(parseTrace(fixture.trace));
      expect(Object.fromEntries(results.map((result) => [result.id, result.status]))).toEqual(
        fixture.expected,
      );
    },
  );

  it("references the steps that cause each sample's gap", () => {
    const byId = Object.fromEntries(SAMPLE_RUNS.map((fixture) => [fixture.id, fixture]));
    const missing = (fixtureId: string, controlId: string) =>
      evaluateTrace(parseTrace(byId[fixtureId]!.trace))
        .find((result) => result.id === controlId)!
        .evidence.filter((ref) => ref.role === "missing")
        .map((ref) => ref.step);

    expect(missing("traceability-gap", "traceability")).toEqual([7, 8, 9]);
    expect(missing("version-drift", "versioning")).toEqual([8, 9]);
    expect(missing("hallucination-not-measured", "hallucinations")).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });
});
