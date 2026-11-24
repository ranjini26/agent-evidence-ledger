import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectJudgeInputs, parseLabelsCsv, parseTrace } from "@/lib/audit";

const root = path.resolve(__dirname, "../../../evals/groundedness");
const traceFiles = readdirSync(path.join(root, "traces"))
  .filter((name) => name.endsWith(".json"))
  .sort();
const traces = traceFiles.map((name) => ({
  name,
  source: JSON.parse(readFileSync(path.join(root, "traces", name), "utf8")) as Record<
    string,
    unknown
  >,
}));
const labels = parseLabelsCsv(readFileSync(path.join(root, "labels.csv"), "utf8"));

describe("groundedness eval dataset", () => {
  it("has at least 30 traces", () => {
    expect(traceFiles.length).toBeGreaterThanOrEqual(30);
  });

  it("labels every trace SAMPLE and parses it with at least one model answer", () => {
    for (const { name, source } of traces) {
      expect(source["sample"], name).toBe(true);
      expect(String(source["label"]), name).toMatch(/^SAMPLE · /);
      expect(collectJudgeInputs(parseTrace(source)).length, name).toBeGreaterThan(0);
    }
  });

  it("has exactly one label row per model answer, and no rows for anything else", () => {
    const expected = traces.flatMap(({ name, source }) =>
      collectJudgeInputs(parseTrace(source)).map((input) => `${name}#${input.answer.stepId}`),
    );
    const actual = labels.map((row) => `${row.trace}#${row.stepId}`);
    expect([...actual].sort()).toEqual([...expected].sort());
    expect(new Set(actual).size).toBe(actual.length);
  });

  it("ships with honest labels: authoring intent filled, human labels left for a person", () => {
    for (const row of labels) {
      expect(["grounded", "ungrounded"]).toContain(row.authoredIntent);
      expect(row.notes.length, `${row.trace}#${row.stepId}`).toBeGreaterThan(0);
    }
    expect(labels.some((row) => row.authoredIntent === "grounded")).toBe(true);
    expect(labels.some((row) => row.authoredIntent === "ungrounded")).toBe(true);
  });
});
