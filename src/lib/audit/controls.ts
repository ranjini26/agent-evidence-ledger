/**
 * Declarative AgentLedger control rules.
 *
 * Each rule has an id, a description, the NIST AI RMF 1.0 subcategory it maps
 * to, and a pure `check` that reads a Trace and returns pass, fail or
 * not_evidenced plus references to the exact trace steps it used.
 *
 * Invariant: missing data returns not_evidenced, never pass. A control is
 * not_evidenced when the trace has no steps, or when no step records any field
 * the control reads. Once at least one step records such a field, steps that
 * lack it count against the control, which can only push toward fail.
 */
import {
  isRecorded,
  isUsableTraceField,
  IDENTIFIER_KEYS,
  TIME_KEYS,
  type Trace,
  type TraceField,
  type TraceStep,
} from "./trace";

export type ControlStatus = "pass" | "fail" | "not_evidenced";
/** Controls computed directly from the trace, synchronously. */
export type CoreControlId = "traceability" | "versioning" | "hallucinations" | "oversight";
/** All controls, including those that need an external judge. */
export type ControlId = CoreControlId | "groundedness";

export interface AuditThresholds {
  /** Minimum % of steps with a usable ID or timestamp. */
  traceabilityMin: number;
  /** Minimum % of steps with a usable model/agent version. */
  versioningMin: number;
  /** Maximum measured hallucination rate, in %. */
  hallucinationMax: number;
  /** Minimum % of steps recording human review or approval. */
  oversightMin: number;
  /** Minimum % of factual claims in model answers supported by earlier tool outputs. */
  groundednessMin: number;
}

export const DEFAULT_THRESHOLDS: AuditThresholds = {
  traceabilityMin: 95,
  versioningMin: 90,
  hallucinationMax: 5,
  oversightMin: 10,
  // A policy starting point, not a measured benchmark. Users can edit it.
  groundednessMin: 90,
};

/**
 * A reference from a control result back into the trace.
 * - role "measured": this field was read into the measurement.
 * - role "missing": this step lacked a usable value for a field the control needs.
 */
export interface EvidenceRef {
  /** Zero-based step index, or null for run-level evidence. */
  step: number | null;
  /** The step's own identifier, when it has one. */
  stepId: string | null;
  /** Location in the uploaded document: a field path for "measured", a step path for "missing". */
  path: string;
  role: "measured" | "missing";
}

/**
 * Where a control sits in NIST AI RMF 1.0 (NIST AI 100-1). The mapping is
 * AgentLedger's interpretation; check it against the framework text before
 * relying on it.
 */
export interface FrameworkMapping {
  framework: "NIST AI RMF 1.0";
  function: "GOVERN" | "MAP" | "MEASURE" | "MANAGE";
  subcategory: string;
  /** Why this check is evidence toward that subcategory. */
  rationale: string;
}

export interface ControlOutcome {
  status: ControlStatus;
  /** The measured percentage, or null when not evidenced. */
  measured: number | null;
  summary: string;
  message: string;
  evidence: EvidenceRef[];
}

export interface ControlRule {
  id: CoreControlId;
  name: string;
  description: string;
  framework: FrameworkMapping;
  /** Whether the threshold is a floor ("minimum") or a ceiling ("maximum"). */
  direction: "minimum" | "maximum";
  thresholdKey: keyof AuditThresholds;
  check(trace: Trace, threshold: number): ControlOutcome;
}

// ---------------------------------------------------------------------------
// Field recognisers
// ---------------------------------------------------------------------------

const VERSION_KEYS = new Set([
  "model",
  "model_name",
  "model_id",
  "model_version",
  "agent_version",
  "prompt_version",
  "deployment_version",
  "version",
  "commit_sha",
]);
const OVERSIGHT_KEYS = new Set([
  "human_review",
  "human_reviewer",
  "reviewer",
  "reviewer_id",
  "human_approval",
  "human_approved",
  "approved_by",
  "review_status",
]);
const BOOLEAN_OVERSIGHT_KEYS = new Set(["human_review", "human_approval", "human_approved"]);
const HALLUCINATION_RATE_KEYS = new Set(["hallucination_rate", "hallucination_rate_pct"]);
const HALLUCINATION_LABEL_KEYS = new Set(["is_hallucination", "hallucination_detected"]);

interface Recogniser {
  /** The field is one this control reads and carries a recorded value. */
  records(field: TraceField): boolean;
  /** The recorded value satisfies the control. */
  satisfies(field: TraceField): boolean;
}

const traceabilityFields: Recogniser = {
  records: (field) =>
    (IDENTIFIER_KEYS.has(field.key) || TIME_KEYS.has(field.key)) && isRecorded(field.value),
  satisfies: isUsableTraceField,
};

const versionFields: Recogniser = {
  records: (field) => VERSION_KEYS.has(field.key) && isRecorded(field.value),
  satisfies(field) {
    if (typeof field.value === "number") return Number.isFinite(field.value) && field.value > 0;
    if (typeof field.value === "string") {
      return !/^(unknown|null|none|undefined|unversioned|n\/a|latest)$/i.test(field.value.trim());
    }
    return false;
  },
};

const oversightFields: Recogniser = {
  records: (field) => OVERSIGHT_KEYS.has(field.key) && isRecorded(field.value),
  satisfies(field) {
    if (typeof field.value === "boolean")
      return BOOLEAN_OVERSIGHT_KEYS.has(field.key) && field.value;
    if (field.key === "review_status") {
      return (
        typeof field.value === "string" &&
        /^(approved|reviewed|complete|completed|accepted|yes)$/i.test(field.value.trim())
      );
    }
    if (field.value === 0) return false;
    if (
      typeof field.value === "string" &&
      /^(false|no|none|pending|not reviewed|not approved)$/i.test(field.value.trim())
    ) {
      return false;
    }
    return true;
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function percentage(count: number, total: number): number | null {
  return total === 0 ? null : Math.round((count / total) * 1000) / 10;
}

export function formatPercentage(value: number | null): string {
  return value === null ? "Not measured" : `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

function measuredRef(step: TraceStep, field: TraceField): EvidenceRef {
  return { step: step.index, stepId: step.stepId, path: field.path, role: "measured" };
}

function missingRef(step: TraceStep): EvidenceRef {
  return { step: step.index, stepId: step.stepId, path: step.path, role: "missing" };
}

/**
 * Shared check for "at least N% of steps record X" controls.
 * not_evidenced when there are no steps or no step records any field the recogniser reads.
 */
function coverageCheck(
  trace: Trace,
  threshold: number,
  recogniser: Recogniser,
  text: { subject: string; absent: string },
): ControlOutcome {
  const perStep = trace.steps.map((step) => ({
    step,
    recorded: step.fields.some(recogniser.records),
    satisfying: step.fields.filter(
      (field) => recogniser.records(field) && recogniser.satisfies(field),
    ),
  }));
  const evidence = perStep.flatMap(({ step, satisfying }) =>
    satisfying.length > 0
      ? satisfying.map((field) => measuredRef(step, field))
      : [missingRef(step)],
  );

  if (trace.steps.length === 0) {
    return {
      status: "not_evidenced",
      measured: null,
      summary: "The trace has no steps to evaluate.",
      message: "No log entries were available to evaluate.",
      evidence: [],
    };
  }
  if (!perStep.some((entry) => entry.recorded)) {
    return {
      status: "not_evidenced",
      measured: null,
      summary: `No step records ${text.absent}.`,
      message: `Not evidenced; no step records ${text.absent}, so this control cannot be assessed.`,
      evidence,
    };
  }

  const measured = percentage(
    perStep.filter((entry) => entry.satisfying.length > 0).length,
    trace.steps.length,
  ) as number;
  const status: ControlStatus = measured >= threshold ? "pass" : "fail";
  return {
    status,
    measured,
    summary: `${formatPercentage(measured)} of entries are identified ${text.subject}.`,
    message: `${formatPercentage(measured)} observed; at least ${threshold}% required.`,
    evidence,
  };
}

function rateFromField(field: TraceField): number | null {
  if (!HALLUCINATION_RATE_KEYS.has(field.key) || typeof field.value !== "number") return null;
  const rate =
    field.key === "hallucination_rate_pct" || field.value > 1 ? field.value : field.value * 100;
  return Number.isFinite(rate) && rate >= 0 && rate <= 100 ? rate : null;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export const traceabilityRule: ControlRule = {
  id: "traceability",
  name: "Traceability",
  description:
    "Each step must carry a stable identifier or a parseable timestamp, so every agent action can be traced back to a specific log entry.",
  framework: {
    framework: "NIST AI RMF 1.0",
    function: "MEASURE",
    subcategory: "MEASURE 2.8",
    rationale:
      "Transparency and accountability risks can only be examined and documented when each agent action is individually identifiable in the record.",
  },
  direction: "minimum",
  thresholdKey: "traceabilityMin",
  check: (trace, threshold) =>
    coverageCheck(trace, threshold, traceabilityFields, {
      subject: "with a stable ID or timestamp",
      absent: "an ID or timestamp",
    }),
};

export const versioningRule: ControlRule = {
  id: "versioning",
  name: "Versioning",
  description:
    "Each step must record the model, agent, prompt or deployment version that produced it, so behaviour can be tied to a specific release.",
  framework: {
    framework: "NIST AI RMF 1.0",
    function: "MANAGE",
    subcategory: "MANAGE 4.1",
    rationale:
      "Post-deployment monitoring and change management depend on knowing which system version produced each output.",
  },
  direction: "minimum",
  thresholdKey: "versioningMin",
  check: (trace, threshold) =>
    coverageCheck(trace, threshold, versionFields, {
      subject: "with a model or agent version",
      absent: "a model or agent version",
    }),
};

export const hallucinationRule: ControlRule = {
  id: "hallucinations",
  name: "Hallucination rate",
  description:
    "The hallucination rate must be explicitly measured, either as a label on every step, a rate on every step, or a run-level rate, and must not exceed the maximum. Partial labelling is not evidence.",
  framework: {
    framework: "NIST AI RMF 1.0",
    function: "MEASURE",
    subcategory: "MEASURE 2.5",
    rationale:
      "A measured hallucination rate is direct evidence about whether the deployed system is valid and reliable.",
  },
  direction: "maximum",
  thresholdKey: "hallucinationMax",
  check(trace, threshold) {
    const { steps } = trace;
    const stepRates = steps.flatMap((step) =>
      step.fields.flatMap((field) => {
        const rate = rateFromField(field);
        return rate === null ? [] : [{ step, field, rate }];
      }),
    );
    const runRates = trace.runFields.flatMap((field) => {
      const rate = rateFromField(field);
      return rate === null ? [] : [{ field, rate }];
    });
    const labels = steps.map((step) => ({
      step,
      label: step.fields.find(
        (field) => HALLUCINATION_LABEL_KEYS.has(field.key) && typeof field.value === "boolean",
      ),
    }));

    let measured: number | null = null;
    let evidence: EvidenceRef[] = [];
    if (steps.length > 0 && stepRates.length === steps.length) {
      measured =
        Math.round(
          (stepRates.reduce((sum, entry) => sum + entry.rate, 0) / stepRates.length) * 10,
        ) / 10;
      evidence = stepRates.map(({ step, field }) => measuredRef(step, field));
    } else if (runRates.length > 0) {
      const last = runRates[runRates.length - 1]!;
      measured = last.rate;
      evidence = [{ step: null, stepId: null, path: last.field.path, role: "measured" }];
    } else if (steps.length > 0 && labels.every((entry) => entry.label !== undefined)) {
      measured = percentage(
        labels.filter((entry) => entry.label?.value === true).length,
        labels.length,
      );
      evidence = labels.map(({ step, label }) => measuredRef(step, label!));
    } else {
      evidence = labels.map(({ step, label }) =>
        label ? measuredRef(step, label) : missingRef(step),
      );
    }

    if (measured === null) {
      return {
        status: "not_evidenced",
        measured: null,
        summary: "No complete, entry-level hallucination measurement was present.",
        message: "Not evidenced; this report will not invent a hallucination measurement.",
        evidence,
      };
    }
    const summary = `${formatPercentage(measured)} measured against ${threshold}% maximum.`;
    return {
      status: measured <= threshold ? "pass" : "fail",
      measured,
      summary,
      message: summary,
      evidence,
    };
  },
};

export const oversightRule: ControlRule = {
  id: "oversight",
  name: "Human oversight",
  description:
    "A minimum share of steps must record that a human reviewed or approved them. Steps that record a pending or negative review count as not reviewed.",
  framework: {
    framework: "NIST AI RMF 1.0",
    function: "MAP",
    subcategory: "MAP 3.5",
    rationale:
      "Recorded human review on individual steps is evidence that defined human oversight processes are operating in practice.",
  },
  direction: "minimum",
  thresholdKey: "oversightMin",
  check: (trace, threshold) =>
    coverageCheck(trace, threshold, oversightFields, {
      subject: "with explicit review or approval fields",
      absent: "a human review or approval field",
    }),
};

/** All controls, in display order. */
export const CONTROLS: readonly ControlRule[] = [
  traceabilityRule,
  versioningRule,
  hallucinationRule,
  oversightRule,
];
