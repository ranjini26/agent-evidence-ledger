import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditOpinion,
  evaluateTrace,
  measuredPaths,
  parseTrace,
  readStoredResults,
  type ControlResult,
} from "@/lib/audit";

const statuses = (values: ControlResult["status"][]) =>
  values.map((status) => ({ status }) as ControlResult);

describe("auditOpinion", () => {
  it("is qualified when any control fails", () => {
    expect(auditOpinion(statuses(["pass", "fail", "not_evidenced", "pass"])).title).toBe(
      "Qualified — findings require attention",
    );
  });

  it("is inconclusive when nothing fails but evidence is missing", () => {
    expect(auditOpinion(statuses(["pass", "pass", "not_evidenced", "pass"])).title).toBe(
      "Inconclusive — evidence is incomplete",
    );
  });

  it("passes only when every control passes", () => {
    expect(auditOpinion(statuses(["pass", "pass", "pass", "pass"])).title).toBe(
      "Pass — supplied evidence meets thresholds",
    );
  });

  it("is inconclusive for a trace with no hallucination labels", () => {
    const results = evaluateTrace(
      parseTrace([
        {
          event_id: "e1",
          timestamp: "2026-11-18T09:00:00Z",
          model_version: "v2",
          human_review: true,
        },
      ]),
    );
    expect(auditOpinion(results).title).toBe("Inconclusive — evidence is incomplete");
  });
});

describe("readStoredResults", () => {
  it("round-trips results saved by this module", () => {
    const results = evaluateTrace(parseTrace({ steps: [{ step_id: "a" }] }));
    expect(readStoredResults(JSON.parse(JSON.stringify(results)))).toEqual(results);
  });

  it("upgrades results saved before the module existed", () => {
    const [legacy] = readStoredResults([
      {
        id: "hallucinations",
        name: "Hallucination rate",
        status: "not-evidenced",
        summary: "s",
        message: "m",
        measured: null,
        threshold: 5,
        direction: "maximum",
        evidencePaths: ["$.events[3].is_hallucination", "$.hallucination_rate"],
      },
    ]);
    expect(legacy?.status).toBe("not_evidenced");
    expect(legacy?.framework.subcategory).toBe("MEASURE 2.5");
    expect(legacy?.evidence).toEqual([
      { step: 3, stepId: null, path: "$.events[3].is_hallucination", role: "measured" },
      { step: null, stepId: null, path: "$.hallucination_rate", role: "measured" },
    ]);
    expect(measuredPaths(legacy!)).toEqual([
      "$.events[3].is_hallucination",
      "$.hallucination_rate",
    ]);
  });

  it("drops unknown controls and non-array input", () => {
    expect(readStoredResults([{ id: "made-up", status: "pass" }])).toEqual([]);
    expect(readStoredResults({ not: "an array" })).toEqual([]);
  });
});

describe("audit module purity", () => {
  it("has no UI, framework or storage imports", () => {
    const dir = path.resolve(__dirname, "../../lib/audit");
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(path.join(dir, file), "utf8");
      const imports = [
        ...source.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm),
      ].map((match) => match[1]);
      for (const specifier of imports) {
        expect(specifier, `${file} imports ${specifier}`).toMatch(/^\.\//);
      }
    }
  });
});
