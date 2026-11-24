# AgentLedger trace schema (`agentledger.trace.v1`)

An agent run is uploaded as one JSON document. AgentLedger reads it into ordered **steps**, and each control reads specific fields from those steps. This file is the contract. The TypeScript source is `src/lib/audit/trace.ts` (`TraceDocument`, `TraceStepRecord`, `parseTrace`).

## Canonical shape

```json
{
  "schema": "agentledger.trace.v1",
  "run_id": "run-2026-11-18-001",
  "label": "Support agent, ticket triage",
  "hallucination_rate": 0.02,
  "steps": [
    {
      "step_id": "step-1",
      "timestamp": "2026-11-18T09:00:00Z",
      "model_version": "agent-v3.2",
      "is_hallucination": false,
      "human_review": true,
      "input": "…",
      "output": "…"
    }
  ]
}
```

The example values above only illustrate the format. They are not real data.

### Top-level fields

| Field                | Type    | Required | Meaning                                                                                                           |
| -------------------- | ------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `steps`              | array   | yes      | Ordered list of agent steps. Each element is a step object.                                                       |
| `schema`             | string  | no       | `"agentledger.trace.v1"`. Recommended; not enforced.                                                              |
| `run_id`             | string  | no       | Identifier for the run.                                                                                           |
| `label`              | string  | no       | Human-readable run name. Synthetic data **must** start with `SAMPLE · `.                                          |
| `sample`             | boolean | no       | `true` for synthetic demo data.                                                                                   |
| `hallucination_rate` | number  | no       | Run-level hallucination rate. `0`–`1` is read as a fraction, `>1`–`100` as a percentage. Out of range is ignored. |

Any other fields are kept with the upload and ignored by scoring.

### Step fields

Every step field is optional. When a field a control needs is absent, that control reports a gap or **not evidenced**. Absence never counts toward a pass.

| Field              | Type    | Read by       | Counts toward the control when…                                                    |
| ------------------ | ------- | ------------- | ---------------------------------------------------------------------------------- |
| `step_id`          | string  | Traceability  | non-empty and not `unknown`/`null`/`none`/`undefined`                              |
| `timestamp`        | string  | Traceability  | parses as a date (ISO-8601 recommended)                                            |
| `model_version`    | string  | Versioning    | non-empty and not `unknown`/`unversioned`/`latest`/`n/a`/`none`/`null`/`undefined` |
| `is_hallucination` | boolean | Hallucination | present on **every** step (the rate is the share of `true`)                        |
| `human_review`     | boolean | Oversight     | `true`; `false` is recorded as _not reviewed_                                      |

## Accepted alternatives

So that existing logs work without conversion, the parser also accepts:

- **Root:** a bare array of steps (paths `$[0]`, `$[1]`…), or an object whose step list is named `events`, `logs`, `traces`, `steps`, `spans`, `records`, `messages`, `tool_calls`, `observations`, `actions` or `outputs`. The first one present, in that order, is used. The list may also sit one level down inside `run`, `trace`, `data`, `payload` or `agent_run`. An object with no step list is treated as a single "Run metadata" step.
- **Key spelling:** keys are normalised to snake_case, so `modelVersion` is read as `model_version`.
- **Nesting:** fields are found up to four levels inside a step (e.g. `metadata.model_version`).
- **Field aliases:**

| Control       | Also accepted                                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Traceability  | IDs: `event_id`, `trace_id`, `span_id`, `request_id`, `log_id`, `id`. Times: `time`, `created_at`, `recorded_at`, `event_time`                                                                                                                                |
| Versioning    | `model`, `model_name`, `model_id`, `agent_version`, `prompt_version`, `deployment_version`, `version`, `commit_sha`                                                                                                                                           |
| Hallucination | Labels: `hallucination_detected`. Rates: `hallucination_rate`, `hallucination_rate_pct` (always a percentage), per step or run-level                                                                                                                          |
| Oversight     | `human_approval`, `human_approved` (booleans); `human_reviewer`, `reviewer`, `reviewer_id`, `approved_by` (a reviewer name or ID; booleans are not read for these keys); `review_status` (`approved`, `reviewed`, `complete`, `completed`, `accepted`, `yes`) |

Oversight values `false`, `no`, `none`, `pending`, `not reviewed`, `not approved` and `0` are recorded as **not reviewed**.

## How controls read a trace

Controls are declarative rules in `src/lib/audit/controls.ts`. Each one has an `id`, a `description`, a NIST AI RMF 1.0 mapping and a pure `check`.

| Control         | id               | NIST AI RMF 1.0 | Measurement                                                      | Default threshold      |
| --------------- | ---------------- | --------------- | ---------------------------------------------------------------- | ---------------------- |
| Traceability    | `traceability`   | MEASURE 2.8     | % of steps with a usable ID or timestamp                         | ≥ 95%                  |
| Versioning      | `versioning`     | MANAGE 4.1      | % of steps with a usable version                                 | ≥ 90%                  |
| Hallucination   | `hallucinations` | MEASURE 2.5     | explicitly measured hallucination rate                           | ≤ 5%                   |
| Human oversight | `oversight`      | MAP 3.5         | % of steps recording human review or approval                    | ≥ 10%                  |
| Groundedness    | `groundedness`   | MEASURE 2.5     | % of answer claims supported by earlier tool outputs (LLM judge) | ≥ 90% (policy default) |

The NIST mappings are AgentLedger's interpretation. Check them against NIST AI 100-1 before relying on them. Each rule's `framework.rationale` explains the reasoning.

### Status rules

- **not_evidenced:** the trace has no steps, or no step records any field the control reads. For hallucination, it is also not evidenced unless every step is labelled, every step has a rate, or a run-level rate exists. Partial labelling is not evidence. Thresholds never turn not evidenced into a pass, not even a 0% minimum.
- **fail:** the control has data, and the measurement is outside the threshold. Once any step records a field, steps that lack a usable value count against the control.
- **pass:** the control has data, and the measurement is within the threshold.

### Evidence references

Every result carries `evidence: EvidenceRef[]`:

```ts
{ step: number | null, stepId: string | null, path: string, role: "measured" | "missing" }
```

- `role: "measured"`: `path` is the exact field read into the measurement, e.g. `$.steps[2].model_version`.
- `role: "missing"`: `path` is a step (`$.steps[7]`) that lacked a usable value.
- `step: null`: run-level evidence, e.g. `$.hallucination_rate`.

## Groundedness (judged control)

Groundedness needs two step types, marked with `type` (or `kind`, `role`, `step_type`, `event_type`):

| Step kind    | `type` values                                                                                       | Text read from                                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Tool output  | `tool_output` (canonical), `tool_result`, `tool_response`, `tool`, `function_result`, `observation` | `content`, `output`, `text`, `result`, `response` or `message`. Objects are serialised as JSON. Name from `tool_name`, `tool` or `name`. |
| Model answer | `model_answer` (canonical), `answer`, `final_answer`, `assistant`, `model_response`                 | the same keys; must be a non-empty string                                                                                                |

```json
{ "step_id": "t1", "type": "tool_output", "tool_name": "orders.lookup", "content": { "status": "shipped" } }
{ "step_id": "a1", "type": "model_answer", "content": "Your order has shipped." }
```

For each model answer, the judge gets that answer and **only the tool outputs that appear before it** in the trace. Claude (default `claude-opus-5-5`, prompt `groundedness-v1`, defined in `src/lib/audit/groundedness.ts`) extracts the answer's factual claims and marks each one `supported`, `unsupported` or `contradicted`, citing tool-output step numbers. A `supported` claim that cites no earlier tool output is downgraded to `unsupported`.

- **not_evidenced:** no API key (no call is made), no model answers, no factual claims in any answer, or the judge failed on **any** answer. A partial check is never reported as a measurement.
- **Measured:** the share of all claims that are supported. An answer is `ungrounded` if any of its claims is unsupported or contradicted.
- Each result records `method`, which holds the method description, the model or models that served the judgements (fallbacks included) and the prompt version. It also records `answers`, the judgement for each answer.

The API key is the user's own. In the app, it is held in React state only and sent from the browser straight to `api.anthropic.com`. It is never stored, logged or sent to AgentLedger. Agreement with hand labels is measured in `evals/groundedness/`.

## Samples

`src/lib/audit/fixtures.ts` holds six synthetic traces in this format (`SAMPLE_RUNS`). Each has `label: "SAMPLE · …"`, `sample: true` and its expected outcome. They are the sample audits seeded on the dashboard. They are not measurements of any real agent.
