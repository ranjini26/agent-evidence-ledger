/**
 * AgentLedger trace schema (agentledger.trace.v1) and the parser that turns
 * an uploaded JSON log into ordered, addressable steps.
 *
 * The full format is documented in docs/trace-schema.md. This file has no UI,
 * framework or storage dependencies.
 */

export const TRACE_SCHEMA_ID = "agentledger.trace.v1";

/** One step of a canonical trace. Every field is optional; unknown fields are kept and ignored. */
export interface TraceStepRecord {
  /** Stable, unique identifier for the step. Read by the traceability control. */
  step_id?: string;
  /** ISO-8601 time the step happened. Read by the traceability control. */
  timestamp?: string;
  /** Model, agent or prompt version that produced the step. Read by the versioning control. */
  model_version?: string;
  /** Whether the step's output was judged a hallucination. Read by the hallucination control. */
  is_hallucination?: boolean;
  /** Whether a human reviewed or approved the step. Read by the oversight control. */
  human_review?: boolean;
  [field: string]: unknown;
}

/** The canonical top-level trace document. */
export interface TraceDocument {
  /** Should be "agentledger.trace.v1". Optional; not enforced. */
  schema?: string;
  run_id?: string;
  /** Human-readable name of the run. Sample traces start with "SAMPLE · ". */
  label?: string;
  /** True for synthetic demo data. */
  sample?: boolean;
  /** Run-level hallucination rate: a fraction (0–1) or a percentage (>1–100). */
  hallucination_rate?: number;
  steps: TraceStepRecord[];
  [field: string]: unknown;
}

/** A field found inside a step or at run level, with its JSONPath-style location. */
export interface TraceField {
  /** snake_case version of the key (`modelVersion` → `model_version`). */
  key: string;
  value: unknown;
  /** Location in the uploaded document, e.g. `$.steps[2].model_version`. */
  path: string;
}

export interface TraceStep {
  /** Zero-based position in the step list. */
  index: number;
  /** Location of the step in the uploaded document, e.g. `$.steps[2]`. */
  path: string;
  /** Display label, e.g. "Step 3". */
  label: string;
  /** The step's identifier, when it records a usable one. */
  stepId: string | null;
  /** The raw step value as uploaded. */
  value: unknown;
  /** Every field in the step, up to four levels deep. */
  fields: TraceField[];
}

export interface Trace {
  steps: TraceStep[];
  /** Scalar fields of the document that sit outside any list (e.g. `$.hallucination_rate`). */
  runFields: TraceField[];
  source: unknown;
}

export class TraceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceParseError";
  }
}

/** Names accepted for the step list, in priority order. `steps` is canonical. */
export const STEP_LIST_KEYS = [
  "events",
  "logs",
  "traces",
  "steps",
  "spans",
  "records",
  "messages",
  "tool_calls",
  "observations",
  "actions",
  "outputs",
] as const;

/** Objects that may wrap the step list one level down, e.g. `{ "run": { "steps": [...] } }`. */
export const STEP_CONTAINER_KEYS = ["run", "trace", "data", "payload", "agent_run"] as const;

const MAX_FIELD_DEPTH = 4;

export const IDENTIFIER_KEYS = new Set([
  "step_id",
  "event_id",
  "trace_id",
  "span_id",
  "request_id",
  "log_id",
  "id",
]);
export const TIME_KEYS = new Set(["timestamp", "time", "created_at", "recorded_at", "event_time"]);

export function normalizeKey(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/** A value counts as recorded unless it is null, undefined or an empty string. */
export function isRecorded(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

export function collectFields(value: unknown, path: string, depth = 0): TraceField[] {
  if (depth > MAX_FIELD_DEPTH || value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const itemPath = `${path}.${key}`;
    return [
      { key: normalizeKey(key), value: item, path: itemPath },
      ...collectFields(item, itemPath, depth + 1),
    ];
  });
}

/** True when the field is a usable identifier or a parseable, non-zero timestamp. */
export function isUsableTraceField(field: TraceField): boolean {
  if (!IDENTIFIER_KEYS.has(field.key) && !TIME_KEYS.has(field.key)) return false;
  if (typeof field.value === "string") {
    const value = field.value.trim();
    if (!value || /^(unknown|null|none|undefined)$/i.test(value)) return false;
    return IDENTIFIER_KEYS.has(field.key) || Number.isFinite(Date.parse(value));
  }
  if (typeof field.value === "number" && Number.isFinite(field.value)) {
    return !TIME_KEYS.has(field.key) || Math.abs(field.value) > 0;
  }
  return false;
}

function stepLabel(collection: string, index: number): string {
  const singular = collection.endsWith("ies")
    ? `${collection.slice(0, -3)}y`
    : collection.endsWith("s")
      ? collection.slice(0, -1)
      : collection;
  return `${singular.charAt(0).toUpperCase()}${singular.slice(1)} ${index + 1}`;
}

function toStep(value: unknown, index: number, path: string, label: string): TraceStep {
  const fields = collectFields(value, path);
  const idField = fields.find(
    (field) =>
      IDENTIFIER_KEYS.has(field.key) &&
      isUsableTraceField(field) &&
      field.path.split(".").length === path.split(".").length + 1,
  );
  return {
    index,
    path,
    label,
    stepId: idField === undefined ? null : String(idField.value),
    value,
    fields,
  };
}

function findStepList(
  source: unknown,
): { items: unknown[]; path: string; collection: string } | null {
  if (Array.isArray(source)) return { items: source, path: "$", collection: "" };
  const root = source as Record<string, unknown>;
  const listKey = STEP_LIST_KEYS.find((key) => Array.isArray(root[key]));
  if (listKey)
    return { items: root[listKey] as unknown[], path: `$.${listKey}`, collection: listKey };

  for (const container of STEP_CONTAINER_KEYS) {
    const value = root[container];
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const fields = value as Record<string, unknown>;
    const nestedKey = STEP_LIST_KEYS.find((key) => Array.isArray(fields[key]));
    if (nestedKey) {
      return {
        items: fields[nestedKey] as unknown[],
        path: `$.${container}.${nestedKey}`,
        collection: nestedKey,
      };
    }
  }
  return null;
}

/** Scalar fields of the document, skipping anything inside an array (step lists included). */
function collectRunFields(value: object, path: string, depth = 0): TraceField[] {
  if (depth > MAX_FIELD_DEPTH) return [];
  return Object.entries(value).flatMap(([key, item]): TraceField[] => {
    if (Array.isArray(item)) return [];
    const itemPath = `${path}.${key}`;
    if (item !== null && typeof item === "object")
      return collectRunFields(item, itemPath, depth + 1);
    return [{ key: normalizeKey(key), value: item, path: itemPath }];
  });
}

/**
 * Parse an uploaded JSON value into a Trace.
 *
 * Accepts the canonical `{ steps: [...] }` document, a bare array of steps, any
 * of the alias list names in STEP_LIST_KEYS (optionally one level inside a
 * STEP_CONTAINER_KEYS object), or a single object, which becomes one
 * "Run metadata" step.
 */
export function parseTrace(source: unknown): Trace {
  if (source === null || typeof source !== "object") {
    throw new TraceParseError("Upload a JSON object or an array of log entries.");
  }

  const list = findStepList(source);
  const steps = list
    ? list.items.map((item, index) =>
        list.collection === ""
          ? toStep(item, index, `${list.path}[${index}]`, `Entry ${index + 1}`)
          : toStep(item, index, `${list.path}[${index}]`, stepLabel(list.collection, index)),
      )
    : [toStep(source, 0, "$", "Run metadata")];

  const runFields = Array.isArray(source) ? [] : collectRunFields(source, "$");

  return { steps, runFields, source };
}

/** Human-readable version of a trace path: `$.steps[2].model_version` → `steps › entry 3 › model_version`. */
export function formatTracePath(path: string): string {
  return (
    path
      .replace(/^\$\.?/, "")
      .replace(/\[(\d+)\]/g, (_match, index: string) => ` › entry ${Number(index) + 1}`)
      .replace(/\./g, " › ") || "Run metadata"
  );
}
