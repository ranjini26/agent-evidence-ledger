import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GROUNDEDNESS_PROMPT_VERSION,
  collectJudgeInputs,
  parseTrace,
  type AnswerJudgement,
} from "@/lib/audit";
import {
  GROUNDEDNESS_JUDGE_MODEL,
  createClaudeGroundednessJudge,
  type MessagesClient,
} from "@/lib/judge/claude-groundedness-judge";

const SECRET = "sk-ant-test-0123456789-secret";
const [input] = collectJudgeInputs(
  parseTrace({
    steps: [
      { type: "tool_output", content: "Order 1042 shipped." },
      { type: "model_answer", content: "Your order shipped." },
    ],
  }),
);

function clientReturning(response: unknown): MessagesClient & { create: ReturnType<typeof vi.fn> } {
  return { create: vi.fn(async () => response) } as never;
}

const okResponse = {
  model: "claude-opus-5-5",
  stop_reason: "end_turn",
  content: [
    {
      type: "text",
      text: JSON.stringify({
        claims: [
          {
            claim: "Order shipped",
            verdict: "supported",
            supporting_steps: [0],
            explanation: "step 0",
          },
        ],
      }),
    },
  ],
  usage: { input_tokens: 120, output_tokens: 40 },
};

afterEach(() => vi.restoreAllMocks());

describe("Claude groundedness judge", () => {
  it("defaults to Claude Opus 5.5 and the current prompt version", () => {
    const judge = createClaudeGroundednessJudge({
      apiKey: SECRET,
      client: clientReturning(okResponse),
    });
    expect(GROUNDEDNESS_JUDGE_MODEL).toBe("claude-opus-5-5");
    expect(judge.model).toBe("claude-opus-5-5");
    expect(judge.promptVersion).toBe(GROUNDEDNESS_PROMPT_VERSION);
  });

  it("sends a structured-output request and returns the parsed judgement and served model", async () => {
    const client = clientReturning(okResponse);
    const judge = createClaudeGroundednessJudge({ apiKey: SECRET, client });
    const result = await judge.judge(input!);

    const request = client.create.mock.calls[0]![0];
    expect(request.model).toBe("claude-opus-5-5");
    expect(request.output_config.format.type).toBe("json_schema");
    expect(request.fallbacks).toBe("default");
    expect(request.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(JSON.stringify(request)).not.toContain(SECRET);
    expect((result.judgement as AnswerJudgement).claims[0]).toMatchObject({
      verdict: "supported",
      supportingSteps: [0],
    });
    expect(result.model).toBe("claude-opus-5-5");
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 40 });
  });

  it("treats a refusal or truncated output as an error, not a judgement", async () => {
    for (const stop_reason of ["refusal", "max_tokens"]) {
      const judge = createClaudeGroundednessJudge({
        apiKey: SECRET,
        client: clientReturning({ ...okResponse, stop_reason }),
      });
      await expect(judge.judge(input!)).rejects.toThrow(
        stop_reason === "refusal" ? /declined/ : /cut off/,
      );
    }
  });

  it("never puts the key in error messages, logs or browser storage", async () => {
    const logged: unknown[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => logged.push(...args));
    }
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const failing = {
      create: vi.fn(async () => {
        throw new Anthropic.AuthenticationError(
          401,
          { error: { message: `bad key ${SECRET}` } },
          `bad key ${SECRET}`,
          new Headers(),
        );
      }),
    } as never;
    const judge = createClaudeGroundednessJudge({ apiKey: SECRET, client: failing });

    const error = (await judge.judge(input!).catch((caught: unknown) => caught)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/rejected/i);
    expect(error.message).not.toContain(SECRET);
    expect(JSON.stringify(logged)).not.toContain(SECRET);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("does not expose the key as a property of the judge", () => {
    const judge = createClaudeGroundednessJudge({
      apiKey: SECRET,
      client: clientReturning(okResponse),
    });
    expect(JSON.stringify(judge)).not.toContain(SECRET);
    expect(Object.values(judge)).not.toContain(SECRET);
  });
});
