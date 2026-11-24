/**
 * Claude-backed GroundednessJudge, using the user's own Anthropic API key.
 *
 * Key handling:
 * - The key is passed in by the caller and captured only in this closure (via
 *   the SDK client). It is never written to storage, never put on the returned
 *   object, never logged, and never included in error messages.
 * - In the browser the SDK talks to api.anthropic.com directly
 *   (`dangerouslyAllowBrowser`), so the key goes only to Anthropic, never to
 *   AgentLedger's own server. That flag exists for exactly this case: a user
 *   supplying their own key in their own browser.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  GROUNDEDNESS_OUTPUT_SCHEMA,
  GROUNDEDNESS_PROMPT_VERSION,
  GROUNDEDNESS_SYSTEM_PROMPT,
  buildGroundednessUserMessage,
  parseJudgement,
  type GroundednessJudge,
  type JudgeInput,
  type JudgeResponse,
} from "@/lib/audit";

export const GROUNDEDNESS_JUDGE_MODEL = "claude-opus-5-5";

/** The one SDK method the judge needs; injectable for tests. */
export type MessagesClient = Pick<Anthropic["beta"]["messages"], "create">;

export interface ClaudeGroundednessJudgeOptions {
  apiKey: string;
  model?: string;
  /** Set when running in a browser tab. */
  browser?: boolean;
  /** Test seam. When given, no SDK client is constructed. */
  client?: MessagesClient;
}

/** Map SDK errors to messages that never echo the request, the response body or the key. */
function safeError(error: unknown): Error {
  if (error instanceof Anthropic.AuthenticationError) {
    return new Error("The Anthropic API rejected the API key (401).");
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new Error("This API key is not permitted to use the judge model (403).");
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new Error("Rate limited by the Anthropic API (429). Try again later.");
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new Error("Could not reach the Anthropic API.");
  }
  if (error instanceof Anthropic.APIError) {
    return new Error(`The Anthropic API returned an error (${error.status ?? "unknown status"}).`);
  }
  if (error instanceof SyntaxError)
    return new Error("The judge returned output that is not valid JSON.");
  return error instanceof Error ? new Error(error.message) : new Error("The judge failed.");
}

export function createClaudeGroundednessJudge(
  options: ClaudeGroundednessJudgeOptions,
): GroundednessJudge {
  const model = options.model ?? GROUNDEDNESS_JUDGE_MODEL;
  const client: MessagesClient =
    options.client ??
    new Anthropic({
      apiKey: options.apiKey,
      dangerouslyAllowBrowser: options.browser === true,
      logLevel: "off",
    }).beta.messages;

  async function judge(input: JudgeInput): Promise<JudgeResponse> {
    try {
      const response = await client.create({
        model,
        max_tokens: 16000,
        // Server-side fallback: if the judge model declines, Anthropic re-runs the
        // request on its recommended fallback model. response.model records which
        // model actually answered, and that is what the result shows.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: {
          effort: "high",
          format: { type: "json_schema", schema: GROUNDEDNESS_OUTPUT_SCHEMA },
        },
        system: GROUNDEDNESS_SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildGroundednessUserMessage(input) }],
      });

      if (response.stop_reason === "refusal") {
        throw new Error("Claude declined to judge this answer (refusal).");
      }
      if (response.stop_reason === "max_tokens") {
        throw new Error("The judge's output was cut off (max_tokens).");
      }
      const text = response.content.find((block) => block.type === "text");
      if (!text || text.type !== "text") throw new Error("The judge returned no text.");
      const judgement = parseJudgement(JSON.parse(text.text), input);
      return {
        judgement,
        model: response.model,
        ...(response.usage
          ? {
              usage: {
                inputTokens: response.usage.input_tokens,
                outputTokens: response.usage.output_tokens,
              },
            }
          : {}),
      };
    } catch (error) {
      throw safeError(error);
    }
  }

  return { model, promptVersion: GROUNDEDNESS_PROMPT_VERSION, judge };
}
