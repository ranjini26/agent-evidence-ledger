import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  GROUNDEDNESS_PROMPT_VERSION,
  buildGroundednessUserMessage,
  collectJudgeInputs,
  evaluateGroundedness,
  evaluateRun,
  evaluateRunOffline,
  parseJudgement,
  parseTrace,
  readStoredResults,
  type GroundednessJudge,
  type JudgeInput,
  type JudgedClaim,
} from "@/lib/audit";

const trace = parseTrace({
  steps: [
    { step_id: "u1", type: "user_message", content: "Where is order 1042?" },
    {
      step_id: "t1",
      type: "tool_output",
      tool_name: "orders.lookup",
      content: { order: 1042, status: "shipped", carrier: "ParcelPost" },
    },
    { step_id: "a1", type: "model_answer", content: "Order 1042 has shipped with ParcelPost." },
    { step_id: "t2", type: "tool_output", tool_name: "orders.eta", content: "ETA 2026-11-20" },
    { step_id: "a2", type: "model_answer", content: "It should arrive on 20 November." },
  ],
});

function fakeJudge(
  claimsFor: (input: JudgeInput) => JudgedClaim[] | Error,
  model = "claude-test",
): GroundednessJudge & { judge: ReturnType<typeof vi.fn> } {
  return {
    model,
    promptVersion: GROUNDEDNESS_PROMPT_VERSION,
    judge: vi.fn(async (input: JudgeInput) => {
      const claims = claimsFor(input);
      if (claims instanceof Error) throw claims;
      return { judgement: { claims }, model };
    }),
  };
}

const supported = (claim: string, steps: number[]): JudgedClaim => ({
  claim,
  verdict: "supported",
  supportingSteps: steps,
  explanation: "stated in tool output",
});
const unsupported = (claim: string): JudgedClaim => ({
  claim,
  verdict: "unsupported",
  supportingSteps: [],
  explanation: "not in any earlier tool output",
});

describe("collectJudgeInputs", () => {
  it("pairs each model answer with only the tool outputs that came before it", () => {
    const inputs = collectJudgeInputs(trace);
    expect(inputs.map((input) => input.answer.step)).toEqual([2, 4]);
    expect(inputs[0]!.toolOutputs.map((output) => output.step)).toEqual([1]);
    expect(inputs[1]!.toolOutputs.map((output) => output.step)).toEqual([1, 3]);
    expect(inputs[0]!.toolOutputs[0]).toMatchObject({
      stepId: "t1",
      toolName: "orders.lookup",
      path: "$.steps[1].content",
    });
    expect(inputs[0]!.toolOutputs[0]!.text).toContain('"status":"shipped"');
    expect(inputs[0]!.answer).toMatchObject({ stepId: "a1", path: "$.steps[2].content" });
  });

  it("recognises role-style steps", () => {
    const inputs = collectJudgeInputs(
      parseTrace({
        messages: [
          { role: "tool", name: "search", output: "Doc says X." },
          { role: "assistant", text: "X." },
        ],
      }),
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.toolOutputs[0]!.text).toBe("Doc says X.");
  });
});

describe("prompt", () => {
  it("includes the answer, the earlier tool outputs with their step numbers, and nothing later", () => {
    const [, second] = collectJudgeInputs(trace);
    const message = buildGroundednessUserMessage(second!);
    expect(message).toContain("It should arrive on 20 November.");
    expect(message).toContain('step="1"');
    expect(message).toContain('step="3"');
    expect(message).not.toContain("Where is order 1042?");
  });
});

describe("parseJudgement", () => {
  const [first] = collectJudgeInputs(trace);

  it("accepts a well-formed judgement", () => {
    const parsed = parseJudgement(
      { claims: [{ claim: "c", verdict: "supported", supporting_steps: [1], explanation: "e" }] },
      first!,
    );
    expect(parsed.claims).toEqual([
      { claim: "c", verdict: "supported", supportingSteps: [1], explanation: "e" },
    ]);
  });

  it("downgrades a 'supported' claim that cites no earlier tool output", () => {
    const parsed = parseJudgement(
      {
        claims: [
          {
            claim: "cites later step",
            verdict: "supported",
            supporting_steps: [3],
            explanation: "",
          },
          { claim: "cites nothing", verdict: "supported", supporting_steps: [], explanation: "" },
          { claim: "cites the user", verdict: "supported", supporting_steps: [0], explanation: "" },
        ],
      },
      first!,
    );
    expect(parsed.claims.map((claim) => claim.verdict)).toEqual([
      "unsupported",
      "unsupported",
      "unsupported",
    ]);
    expect(parsed.claims.every((claim) => claim.supportingSteps.length === 0)).toBe(true);
  });

  it("rejects malformed output", () => {
    expect(() => parseJudgement({ claims: "nope" }, first!)).toThrow();
    expect(() => parseJudgement({ claims: [{ claim: "x", verdict: "maybe" }] }, first!)).toThrow();
    expect(() => parseJudgement(null, first!)).toThrow();
  });
});

describe("groundedness control", () => {
  it("is not_evidenced without a judge (no API key) and makes no call", async () => {
    const result = await evaluateGroundedness(trace, 90, null);
    expect(result.status).toBe("not_evidenced");
    expect(result.measured).toBeNull();
    expect(result.message).toMatch(/API key/);
    expect(result.method).toEqual({
      name: expect.stringMatching(/judge/i),
      model: null,
      promptVersion: GROUNDEDNESS_PROMPT_VERSION,
    });
  });

  it("is not_evidenced when the trace has no model answers, without calling the judge", async () => {
    const judge = fakeJudge(() => []);
    const result = await evaluateGroundedness(parseTrace({ steps: [{ step_id: "x" }] }), 0, judge);
    expect(result.status).toBe("not_evidenced");
    expect(judge.judge).not.toHaveBeenCalled();
  });

  it("passes when every claim is supported and records method, model and prompt version", async () => {
    const judge = fakeJudge((input) =>
      input.answer.step === 2
        ? [supported("Order 1042 shipped", [1]), supported("Carrier is ParcelPost", [1])]
        : [supported("Arrives 20 November", [3])],
    );
    const result = await evaluateGroundedness(trace, 90, judge);
    expect(result.status).toBe("pass");
    expect(result.measured).toBe(100);
    expect(result.method).toMatchObject({
      model: "claude-test",
      promptVersion: GROUNDEDNESS_PROMPT_VERSION,
    });
    expect(result.answers?.map((answer) => answer.verdict)).toEqual(["grounded", "grounded"]);
    expect(result.evidence.map((ref) => ref.path)).toEqual([
      "$.steps[2].content",
      "$.steps[1].content",
      "$.steps[4].content",
      "$.steps[3].content",
    ]);
  });

  it("fails below the threshold and marks the answer with the unsupported claim", async () => {
    const judge = fakeJudge((input) =>
      input.answer.step === 2
        ? [
            supported("Order 1042 shipped", [1]),
            supported("ParcelPost", [1]),
            supported("1042", [1]),
          ]
        : [unsupported("Arrives 20 November")],
    );
    const result = await evaluateGroundedness(trace, 90, judge);
    expect(result.status).toBe("fail");
    expect(result.measured).toBe(75);
    expect(result.answers?.map((answer) => answer.verdict)).toEqual(["grounded", "ungrounded"]);
  });

  it("counts contradicted claims as not supported", async () => {
    const judge = fakeJudge(() => [
      {
        claim: "Status is delayed",
        verdict: "contradicted",
        supportingSteps: [],
        explanation: "says shipped",
      },
    ]);
    const result = await evaluateGroundedness(trace, 90, judge);
    expect(result.measured).toBe(0);
    expect(result.status).toBe("fail");
    expect(result.answers?.every((answer) => answer.verdict === "ungrounded")).toBe(true);
  });

  it("is not_evidenced, never pass, when any answer could not be judged", async () => {
    const judge = fakeJudge((input) =>
      input.answer.step === 2 ? [supported("ok", [1])] : new Error("rate limited"),
    );
    const result = await evaluateGroundedness(trace, 0, judge);
    expect(result.status).toBe("not_evidenced");
    expect(result.measured).toBeNull();
    expect(result.answers?.[1]).toMatchObject({ verdict: "not_evidenced", error: "rate limited" });
  });

  it("does not present the requested model as the judge when every call failed", async () => {
    const result = await evaluateGroundedness(
      trace,
      0,
      fakeJudge(() => new Error("401")),
    );
    expect(result.method.model).toBe("claude-test (requested; no judgement returned)");
  });

  it("is not_evidenced when no answer contains a factual claim", async () => {
    const result = await evaluateGroundedness(
      trace,
      0,
      fakeJudge(() => []),
    );
    expect(result.status).toBe("not_evidenced");
    expect(result.answers?.map((answer) => answer.verdict)).toEqual(["grounded", "grounded"]);
  });

  it("records every model that answered when a fallback model was used", async () => {
    let call = 0;
    const judge: GroundednessJudge = {
      model: "primary",
      promptVersion: GROUNDEDNESS_PROMPT_VERSION,
      judge: async () => ({
        judgement: { claims: [supported("c", [1])] },
        model: call++ === 0 ? "primary" : "fallback",
      }),
    };
    const result = await evaluateGroundedness(trace, 0, judge);
    expect(result.method?.model).toBe("primary, fallback");
  });
});

describe("full run evaluation", () => {
  it("adds groundedness after the four core controls", async () => {
    const results = await evaluateRun(trace, DEFAULT_THRESHOLDS, null);
    expect(results.map((result) => result.id)).toEqual([
      "traceability",
      "versioning",
      "hallucinations",
      "oversight",
      "groundedness",
    ]);
    expect(evaluateRunOffline(trace, DEFAULT_THRESHOLDS).map((r) => r.status)).toEqual(
      results.map((r) => r.status),
    );
  });

  it("round-trips a judged result through storage with its method and answers", async () => {
    const judge = fakeJudge(() => [supported("c", [1])]);
    const result = await evaluateGroundedness(trace, 90, judge);
    const [stored] = readStoredResults(JSON.parse(JSON.stringify([result])));
    expect(stored).toEqual(result);
  });
});
