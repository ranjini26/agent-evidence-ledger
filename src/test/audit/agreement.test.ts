import { describe, expect, it } from "vitest";
import { computeAgreement, parseLabelsCsv, type LabelledPrediction } from "@/lib/audit";

const row = (
  human: LabelledPrediction["human"],
  predicted: LabelledPrediction["predicted"],
  id = Math.random().toString(),
): LabelledPrediction => ({ id, human, predicted });

describe("computeAgreement (positive class = ungrounded)", () => {
  it("computes precision, recall, agreement and Cohen's kappa from a known confusion matrix", () => {
    // tp=3, fp=1, fn=2, tn=4
    const rows = [
      ...Array.from({ length: 3 }, () => row("ungrounded", "ungrounded")),
      row("grounded", "ungrounded"),
      ...Array.from({ length: 2 }, () => row("ungrounded", "grounded")),
      ...Array.from({ length: 4 }, () => row("grounded", "grounded")),
    ];
    const result = computeAgreement(rows);
    expect(result.confusion).toEqual({ tp: 3, fp: 1, fn: 2, tn: 4 });
    expect(result.compared).toBe(10);
    expect(result.precision).toBeCloseTo(0.75);
    expect(result.recall).toBeCloseTo(0.6);
    expect(result.f1).toBeCloseTo(2 / 3);
    expect(result.agreement).toBeCloseTo(0.7);
    // po = 0.7, pe = (0.5*0.4) + (0.5*0.6) = 0.5 → kappa = 0.4
    expect(result.cohensKappa).toBeCloseTo(0.4);
  });

  it("excludes unlabelled rows and not_evidenced predictions and counts them", () => {
    const result = computeAgreement([
      row(null, "ungrounded"),
      row("ungrounded", "not_evidenced"),
      row("grounded", "grounded"),
    ]);
    expect(result).toMatchObject({
      total: 3,
      labelled: 2,
      unlabelled: 1,
      notEvidenced: 1,
      compared: 1,
    });
  });

  it("returns null for metrics that are undefined instead of inventing a value", () => {
    const none = computeAgreement([]);
    expect(none.precision).toBeNull();
    expect(none.recall).toBeNull();
    expect(none.agreement).toBeNull();
    expect(none.cohensKappa).toBeNull();

    const noPositivePredictions = computeAgreement([row("ungrounded", "grounded")]);
    expect(noPositivePredictions.precision).toBeNull();
    expect(noPositivePredictions.recall).toBe(0);
  });
});

describe("parseLabelsCsv", () => {
  it("reads quoted fields, blank human labels and notes containing commas", () => {
    const rows = parseLabelsCsv(
      "trace,step_id,authored_intent,human_label,notes\n" +
        'gt-01.json,a1,grounded,,"restates status, carrier"\n' +
        'gt-02.json,a1,ungrounded,ungrounded,"says ""soon"""\n',
    );
    expect(rows).toEqual([
      {
        trace: "gt-01.json",
        stepId: "a1",
        authoredIntent: "grounded",
        humanLabel: null,
        notes: "restates status, carrier",
      },
      {
        trace: "gt-02.json",
        stepId: "a1",
        authoredIntent: "ungrounded",
        humanLabel: "ungrounded",
        notes: 'says "soon"',
      },
    ]);
  });

  it("rejects unknown label values", () => {
    expect(() =>
      parseLabelsCsv("trace,step_id,authored_intent,human_label,notes\nx.json,a,grounded,maybe,\n"),
    ).toThrow(/human_label/);
  });
});
