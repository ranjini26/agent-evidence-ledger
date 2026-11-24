/**
 * Run every control rule over a trace, form the overall opinion, and read
 * results back from storage. Pure: no UI, framework or storage dependencies.
 */
import {
  CONTROLS,
  DEFAULT_THRESHOLDS,
  type AuditThresholds,
  type ControlId,
  type ControlOutcome,
  type ControlRule,
  type ControlStatus,
  type EvidenceRef,
  type FrameworkMapping,
} from "./controls";
import {
  evaluateGroundedness,
  groundednessRule,
  groundednessWithoutJudge,
  type AnswerGroundedness,
  type GroundednessJudge,
  type JudgeMethod,
} from "./groundedness";
import type { Trace } from "./trace";

/** A rule's outcome plus the rule metadata needed to display and store it. */
export interface ControlResult extends ControlOutcome {
  id: ControlId;
  name: string;
  description: string;
  framework: FrameworkMapping;
  threshold: number;
  direction: ControlRule["direction"];
  /** How a judged control was produced: method, model(s) and prompt version. */
  method?: JudgeMethod;
  /** Per-answer judgements for the groundedness control. */
  answers?: AnswerGroundedness[];
}

export function evaluateTrace(
  trace: Trace,
  thresholds: AuditThresholds = DEFAULT_THRESHOLDS,
  rules: readonly ControlRule[] = CONTROLS,
): ControlResult[] {
  return rules.map((rule) => {
    const threshold = thresholds[rule.thresholdKey];
    return {
      id: rule.id,
      name: rule.name,
      description: rule.description,
      framework: rule.framework,
      threshold,
      direction: rule.direction,
      ...rule.check(trace, threshold),
    };
  });
}

/**
 * All five controls. Groundedness needs a judge; with `judge: null` (no API
 * key) it is not_evidenced and no call is made.
 */
export async function evaluateRun(
  trace: Trace,
  thresholds: AuditThresholds = DEFAULT_THRESHOLDS,
  judge: GroundednessJudge | null = null,
): Promise<ControlResult[]> {
  return [
    ...evaluateTrace(trace, thresholds),
    await evaluateGroundedness(trace, thresholds.groundednessMin, judge),
  ];
}

/** Same as evaluateRun with no judge, synchronously. */
export function evaluateRunOffline(
  trace: Trace,
  thresholds: AuditThresholds = DEFAULT_THRESHOLDS,
): ControlResult[] {
  return [
    ...evaluateTrace(trace, thresholds),
    groundednessWithoutJudge(trace, thresholds.groundednessMin),
  ];
}

const COUNT_WORDS = ["zero", "one", "two", "three", "four", "five", "six"];

export function auditOpinion(results: Pick<ControlResult, "status">[]): {
  title: string;
  explanation: string;
} {
  const failures = results.filter((result) => result.status === "fail").length;
  const unevidenced = results.filter((result) => result.status === "not_evidenced").length;
  if (failures > 0) {
    return {
      title: "Qualified — findings require attention",
      explanation: `${failures} control${failures === 1 ? "" : "s"} fell outside the selected threshold${failures === 1 ? "" : "s"}; ${unevidenced} control${unevidenced === 1 ? "" : "s"} lacked evidence. Review the linked entries before drawing a conclusion.`,
    };
  }
  if (unevidenced > 0) {
    return {
      title: "Inconclusive — evidence is incomplete",
      explanation: `${unevidenced} control${unevidenced === 1 ? " was" : "s were"} not evidenced in the supplied logs. Passing checks apply only to the entries and measurements provided.`,
    };
  }
  return {
    title: "Pass — supplied evidence meets thresholds",
    explanation: `All ${COUNT_WORDS[results.length] ?? results.length} checks met the selected thresholds. This opinion applies only to the log supplied and is not an independent certification.`,
  };
}

/** Field paths that were read into a result's measurement. */
export function measuredPaths(result: ControlResult): string[] {
  return result.evidence.filter((ref) => ref.role === "measured").map((ref) => ref.path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readStatus(value: unknown): ControlStatus {
  if (value === "pass" || value === "fail") return value;
  // Anything else, including the legacy "not-evidenced" spelling, is not evidenced.
  return "not_evidenced";
}

function readEvidence(stored: Record<string, unknown>): EvidenceRef[] {
  if (Array.isArray(stored["evidence"])) {
    return stored["evidence"].filter(isRecord).map((ref) => ({
      step: typeof ref["step"] === "number" ? ref["step"] : null,
      stepId: typeof ref["stepId"] === "string" ? ref["stepId"] : null,
      path: String(ref["path"] ?? ""),
      role: ref["role"] === "missing" ? "missing" : "measured",
    }));
  }
  // Results saved before this module stored only measured field paths.
  if (Array.isArray(stored["evidencePaths"])) {
    return stored["evidencePaths"]
      .filter((path): path is string => typeof path === "string")
      .map((path) => {
        const match = /\[(\d+)\]/.exec(path);
        return {
          step: match ? Number(match[1]) : null,
          stepId: null,
          path,
          role: "measured" as const,
        };
      });
  }
  return [];
}

/**
 * Read control results from stored JSON (a database row or IndexedDB record).
 * Upgrades results saved before this module existed and drops unknown controls.
 * Stored results are historical: they are not re-scored.
 */
export function readStoredResults(stored: unknown): ControlResult[] {
  if (!Array.isArray(stored)) return [];
  return stored.filter(isRecord).flatMap((item) => {
    const rule = [...CONTROLS, groundednessRule].find((candidate) => candidate.id === item["id"]);
    if (!rule) return [];
    const judged = rule.id === groundednessRule.id && isRecord(item["method"]);
    const measured = typeof item["measured"] === "number" ? item["measured"] : null;
    const threshold =
      typeof item["threshold"] === "number"
        ? item["threshold"]
        : DEFAULT_THRESHOLDS[rule.thresholdKey];
    return [
      {
        id: rule.id,
        name: typeof item["name"] === "string" ? item["name"] : rule.name,
        description:
          typeof item["description"] === "string" ? item["description"] : rule.description,
        framework: rule.framework,
        threshold,
        direction: rule.direction,
        status: readStatus(item["status"]),
        measured,
        summary: typeof item["summary"] === "string" ? item["summary"] : "",
        message: typeof item["message"] === "string" ? item["message"] : "",
        evidence: readEvidence(item),
        ...(judged
          ? {
              method: item["method"] as unknown as JudgeMethod,
              answers: (Array.isArray(item["answers"])
                ? item["answers"]
                : []) as AnswerGroundedness[],
            }
          : {}),
      },
    ];
  });
}
