/**
 * SAMPLE run fixtures. Synthetic data for demos and tests only.
 *
 * Every fixture is labelled "SAMPLE · ..." in its label and inside the trace
 * (`label`, `sample: true`). These six scenarios are the device-only sample
 * audits seeded on the dashboard. They are not measurements of any real agent.
 */
import type { ControlStatus, CoreControlId } from "./controls";
import { TRACE_SCHEMA_ID, type TraceDocument } from "./trace";

export interface SampleRunFixture {
  id: string;
  /** Always starts with "SAMPLE · ". */
  label: `SAMPLE · ${string}`;
  /** What the scenario demonstrates. */
  description: string;
  /** Expected status per core control under DEFAULT_THRESHOLDS. */
  expected: Record<CoreControlId, ControlStatus>;
  trace: TraceDocument & { run_id: string; label: string; sample: true };
}

export const SAMPLE_RUNS: readonly SampleRunFixture[] = [
  {
    id: "complete-evidence",
    label: "SAMPLE · Well-governed support run",
    description:
      "Every step is identified and versioned, all steps are labelled with no hallucinations, and 2 of 10 steps record human review.",
    expected: {
      traceability: "pass",
      versioning: "pass",
      hallucinations: "pass",
      oversight: "pass",
    },
    trace: {
      schema: TRACE_SCHEMA_ID,
      run_id: "sample-complete-evidence",
      label: "SAMPLE · Well-governed support run",
      sample: true,
      steps: [
        {
          step_id: "complete-evidence-1",
          model_version: "agent-v3.2",
          is_hallucination: false,
          human_review: true,
        },
        {
          step_id: "complete-evidence-2",
          model_version: "agent-v3.2",
          is_hallucination: false,
          human_review: true,
        },
        { step_id: "complete-evidence-3", model_version: "agent-v3.2", is_hallucination: false },
        { step_id: "complete-evidence-4", model_version: "agent-v3.2", is_hallucination: false },
        { step_id: "complete-evidence-5", model_version: "agent-v3.2", is_hallucination: false },
        { step_id: "complete-evidence-6", model_version: "agent-v3.2", is_hallucination: false },
        { step_id: "complete-evidence-7", model_version: "agent-v3.2", is_hallucination: false },
        { step_id: "complete-evidence-8", model_version: "agent-v3.2", is_hallucination: false },
        { step_id: "complete-evidence-9", model_version: "agent-v3.2", is_hallucination: false },
        { step_id: "complete-evidence-10", model_version: "agent-v3.2", is_hallucination: false },
      ],
    },
  },
  {
    id: "traceability-gap",
    label: "SAMPLE · Untracked tool execution",
    description: "Steps 8–10 have no step ID or timestamp.",
    expected: {
      traceability: "fail",
      versioning: "pass",
      hallucinations: "pass",
      oversight: "pass",
    },
    trace: {
      schema: TRACE_SCHEMA_ID,
      run_id: "sample-traceability-gap",
      label: "SAMPLE · Untracked tool execution",
      sample: true,
      steps: [
        {
          step_id: "traceability-gap-1",
          model_version: "agent-v3.2",
          is_hallucination: false,
          human_review: true,
        },
        {
          step_id: "traceability-gap-2",
          model_version: "agent-v3.2",
          is_hallucination: false,
          human_review: true,
        },
        { step_id: "traceability-gap-3", model_version: "agent-v3.2", is_hallucination: false },
        { step_id: "traceability-gap-4", model_version: "agent-v3.2", is_hallucination: false },
        { step_id: "traceability-gap-5", model_version: "agent-v3.2", is_hallucination: false },
        { step_id: "traceability-gap-6", model_version: "agent-v3.2", is_hallucination: false },
        { step_id: "traceability-gap-7", model_version: "agent-v3.2", is_hallucination: false },
        { model_version: "agent-v3.2", is_hallucination: false },
        { model_version: "agent-v3.2", is_hallucination: false },
        { model_version: "agent-v3.2", is_hallucination: false },
      ],
    },
  },
  {
    id: "version-drift",
    label: "SAMPLE · Model version drift",
    description: "Steps 9–10 do not record a model version.",
    expected: {
      traceability: "pass",
      versioning: "fail",
      hallucinations: "pass",
      oversight: "pass",
    },
    trace: {
      schema: TRACE_SCHEMA_ID,
      run_id: "sample-version-drift",
      label: "SAMPLE · Model version drift",
      sample: true,
      steps: [
        {
          step_id: "version-drift-1",
          model_version: "agent-v3.2",
          is_hallucination: false,
          human_review: true,
        },
        {
          step_id: "version-drift-2",
          model_version: "agent-v3.2",
          is_hallucination: false,
          human_review: true,
        },
        { step_id: "version-drift-3", model_version: "agent-v3.2", is_hallucination: false },
        { step_id: "version-drift-4", model_version: "agent-v3.2", is_hallucination: false },
        { step_id: "version-drift-5", model_version: "agent-v3.2", is_hallucination: false },
        { step_id: "version-drift-6", model_version: "agent-v3.2", is_hallucination: false },
        { step_id: "version-drift-7", model_version: "agent-v3.2", is_hallucination: false },
        { step_id: "version-drift-8", model_version: "agent-v3.2", is_hallucination: false },
        { step_id: "version-drift-9", is_hallucination: false },
        { step_id: "version-drift-10", is_hallucination: false },
      ],
    },
  },
  {
    id: "high-hallucination-rate",
    label: "SAMPLE · High hallucination rate",
    description: "Steps 1–2 are labelled as hallucinations (20%).",
    expected: {
      traceability: "pass",
      versioning: "pass",
      hallucinations: "fail",
      oversight: "pass",
    },
    trace: {
      schema: TRACE_SCHEMA_ID,
      run_id: "sample-high-hallucination-rate",
      label: "SAMPLE · High hallucination rate",
      sample: true,
      steps: [
        {
          step_id: "high-hallucination-rate-1",
          model_version: "agent-v3.2",
          is_hallucination: true,
          human_review: true,
        },
        {
          step_id: "high-hallucination-rate-2",
          model_version: "agent-v3.2",
          is_hallucination: true,
          human_review: true,
        },
        {
          step_id: "high-hallucination-rate-3",
          model_version: "agent-v3.2",
          is_hallucination: false,
        },
        {
          step_id: "high-hallucination-rate-4",
          model_version: "agent-v3.2",
          is_hallucination: false,
        },
        {
          step_id: "high-hallucination-rate-5",
          model_version: "agent-v3.2",
          is_hallucination: false,
        },
        {
          step_id: "high-hallucination-rate-6",
          model_version: "agent-v3.2",
          is_hallucination: false,
        },
        {
          step_id: "high-hallucination-rate-7",
          model_version: "agent-v3.2",
          is_hallucination: false,
        },
        {
          step_id: "high-hallucination-rate-8",
          model_version: "agent-v3.2",
          is_hallucination: false,
        },
        {
          step_id: "high-hallucination-rate-9",
          model_version: "agent-v3.2",
          is_hallucination: false,
        },
        {
          step_id: "high-hallucination-rate-10",
          model_version: "agent-v3.2",
          is_hallucination: false,
        },
      ],
    },
  },
  {
    id: "oversight-gap",
    label: "SAMPLE · Human review missing",
    description: "No step records any human review field, so oversight cannot be assessed.",
    expected: {
      traceability: "pass",
      versioning: "pass",
      hallucinations: "pass",
      oversight: "not_evidenced",
    },
    trace: {
      schema: TRACE_SCHEMA_ID,
      run_id: "sample-oversight-gap",
      label: "SAMPLE · Human review missing",
      sample: true,
      steps: [
        { step_id: "oversight-gap-1", model_version: "agent-v3.2", is_hallucination: false },
        { step_id: "oversight-gap-2", model_version: "agent-v3.2", is_hallucination: false },
        { step_id: "oversight-gap-3", model_version: "agent-v3.2", is_hallucination: false },
        { step_id: "oversight-gap-4", model_version: "agent-v3.2", is_hallucination: false },
        { step_id: "oversight-gap-5", model_version: "agent-v3.2", is_hallucination: false },
        { step_id: "oversight-gap-6", model_version: "agent-v3.2", is_hallucination: false },
        { step_id: "oversight-gap-7", model_version: "agent-v3.2", is_hallucination: false },
        { step_id: "oversight-gap-8", model_version: "agent-v3.2", is_hallucination: false },
        { step_id: "oversight-gap-9", model_version: "agent-v3.2", is_hallucination: false },
        { step_id: "oversight-gap-10", model_version: "agent-v3.2", is_hallucination: false },
      ],
    },
  },
  {
    id: "hallucination-not-measured",
    label: "SAMPLE · Hallucination evidence missing",
    description: "No step carries a hallucination label, so the rate is not measured.",
    expected: {
      traceability: "pass",
      versioning: "pass",
      hallucinations: "not_evidenced",
      oversight: "pass",
    },
    trace: {
      schema: TRACE_SCHEMA_ID,
      run_id: "sample-hallucination-not-measured",
      label: "SAMPLE · Hallucination evidence missing",
      sample: true,
      steps: [
        {
          step_id: "hallucination-not-measured-1",
          model_version: "agent-v3.2",
          human_review: true,
        },
        {
          step_id: "hallucination-not-measured-2",
          model_version: "agent-v3.2",
          human_review: true,
        },
        { step_id: "hallucination-not-measured-3", model_version: "agent-v3.2" },
        { step_id: "hallucination-not-measured-4", model_version: "agent-v3.2" },
        { step_id: "hallucination-not-measured-5", model_version: "agent-v3.2" },
        { step_id: "hallucination-not-measured-6", model_version: "agent-v3.2" },
        { step_id: "hallucination-not-measured-7", model_version: "agent-v3.2" },
        { step_id: "hallucination-not-measured-8", model_version: "agent-v3.2" },
        { step_id: "hallucination-not-measured-9", model_version: "agent-v3.2" },
        { step_id: "hallucination-not-measured-10", model_version: "agent-v3.2" },
      ],
    },
  },
];
