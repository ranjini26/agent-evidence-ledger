export type AuditStatus = "pass" | "fail" | "not-evidenced";

export interface AuditThresholds {
  traceabilityMin: number;
  versioningMin: number;
  hallucinationMax: number;
  oversightMin: number;
}

export interface AuditCheck {
  id: "traceability" | "versioning" | "hallucinations" | "oversight";
  name: string;
  status: AuditStatus;
  summary: string;
  measured: number | null;
  threshold: number;
  direction: "minimum" | "maximum";
  evidencePaths: string[];
  message: string;
}

export interface AuditEvent {
  path: string;
  label: string;
  value: unknown;
}

export const DEFAULT_THRESHOLDS: AuditThresholds = {
  traceabilityMin: 95,
  versioningMin: 90,
  hallucinationMax: 5,
  oversightMin: 10,
};

const IDENTIFIER_KEYS = new Set(["event_id", "trace_id", "span_id", "request_id", "log_id", "id"]);
const TIME_KEYS = new Set(["timestamp", "time", "created_at", "recorded_at", "event_time"]);
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
const HALLUCINATION_RATE_KEYS = new Set(["hallucination_rate", "hallucination_rate_pct"]);
const HALLUCINATION_LABEL_KEYS = new Set(["is_hallucination", "hallucination_detected"]);
const EVENT_LIST_KEYS = [
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
];

function eventLabel(collection: string, index: number): string {
  const singular = collection.endsWith("ies")
    ? `${collection.slice(0, -3)}y`
    : collection.endsWith("s")
      ? collection.slice(0, -1)
      : collection;
  return `${singular.charAt(0).toUpperCase()}${singular.slice(1)} ${index + 1}`;
}

function normalizedKey(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function scalarIsPresent(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

function isRecordedHumanOversight(field: { key: string; value: unknown }): boolean {
  if (!OVERSIGHT_KEYS.has(field.key) || !scalarIsPresent(field.value)) return false;
  if (typeof field.value === "boolean") return field.key === "human_review" || field.key === "human_approval" || field.key === "human_approved" ? field.value : false;
  if (field.key === "review_status") {
    return typeof field.value === "string" && /^(approved|reviewed|complete|completed|accepted|yes)$/i.test(field.value.trim());
  }
  if (field.value === 0) return false;
  if (typeof field.value === "string" && /^(false|no|none|pending|not reviewed|not approved)$/i.test(field.value.trim())) return false;
  return true;
}

function isTraceabilityEvidence(field: { key: string; value: unknown }): boolean {
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

function isRecordedVersion(field: { key: string; value: unknown }): boolean {
  if (!VERSION_KEYS.has(field.key) || !scalarIsPresent(field.value)) return false;
  if (typeof field.value === "boolean") return false;
  if (typeof field.value === "number") return Number.isFinite(field.value) && field.value > 0;
  if (typeof field.value === "string") {
    return !/^(unknown|null|none|undefined|unversioned|n\/a|latest)$/i.test(field.value.trim());
  }
  return false;
}

function collectFields(value: unknown, path: string, depth = 0): Array<{ key: string; value: unknown; path: string }> {
  if (depth > 4 || value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const itemPath = `${path}.${key}`;
    const current = { key: normalizedKey(key), value: item, path: itemPath };
    return [current, ...collectFields(item, itemPath, depth + 1)];
  });
}

export function extractAuditEvents(source: unknown): AuditEvent[] {
  if (Array.isArray(source)) {
    return source.map((value, index) => ({ path: `$[${index}]`, label: `Entry ${index + 1}`, value }));
  }

  if (source === null || typeof source !== "object") {
    throw new Error("Upload a JSON object or an array of log entries.");
  }

  const root = source as Record<string, unknown>;
  const listKey = EVENT_LIST_KEYS.find((key) => Array.isArray(root[key]));
  if (listKey) {
    return (root[listKey] as unknown[]).map((value, index) => ({
      path: `$.${listKey}[${index}]`,
      label: eventLabel(listKey, index),
      value,
    }));
  }

  for (const container of ["run", "trace", "data", "payload", "agent_run"]) {
    const value = root[container];
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const fields = value as Record<string, unknown>;
    const nestedKey = EVENT_LIST_KEYS.find((key) => Array.isArray(fields[key]));
    if (!nestedKey) continue;
    return (fields[nestedKey] as unknown[]).map((event, index) => ({
      path: `$.${container}.${nestedKey}[${index}]`,
      label: eventLabel(nestedKey, index),
      value: event,
    }));
  }

  return [{ path: "$", label: "Run metadata", value: source }];
}

function percentage(count: number, total: number): number | null {
  return total === 0 ? null : Math.round((count / total) * 1000) / 10;
}

function shortPercentage(value: number | null): string {
  return value === null ? "Not measured" : `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

export function scoreAudit(
  events: AuditEvent[],
  thresholds: AuditThresholds = DEFAULT_THRESHOLDS,
  source?: unknown,
): AuditCheck[] {
  const fieldsByEvent = events.map((event) => collectFields(event.value, event.path));
  const traced = fieldsByEvent.map((fields) => fields.some(isTraceabilityEvidence));
  const versioned = fieldsByEvent.map((fields) => fields.some(isRecordedVersion));
  const oversight = fieldsByEvent.map((fields) => fields.some(isRecordedHumanOversight));

  const rates = fieldsByEvent.flatMap((fields) =>
    fields.flatMap((field) => {
      if (!HALLUCINATION_RATE_KEYS.has(field.key) || typeof field.value !== "number") return [];
      const rate = field.key === "hallucination_rate_pct" || field.value > 1 ? field.value : field.value * 100;
      return Number.isFinite(rate) && rate >= 0 && rate <= 100 ? [{ path: field.path, rate }] : [];
    }),
  );
  const topLevelRates = source === undefined
    ? []
    : collectFields(source, "$").flatMap((field) => {
        if (field.path.includes("[")) return [];
        if (!HALLUCINATION_RATE_KEYS.has(field.key) || typeof field.value !== "number") return [];
        const rate = field.key === "hallucination_rate_pct" || field.value > 1 ? field.value : field.value * 100;
        return Number.isFinite(rate) && rate >= 0 && rate <= 100 ? [{ path: field.path, rate }] : [];
      });
  const labeledEvents = fieldsByEvent.map((fields) =>
    fields.find((field) => HALLUCINATION_LABEL_KEYS.has(field.key) && typeof field.value === "boolean"),
  );
  const hallucinationPaths = rates.length === events.length && events.length > 0
    ? rates.map((entry) => entry.path)
    : topLevelRates.length > 0
      ? topLevelRates.map((entry) => entry.path)
      : rates.map((entry) => entry.path);
  const measuredHallucinationRate = rates.length === events.length && events.length > 0
    ? Math.round((rates.reduce((sum, entry) => sum + entry.rate, 0) / rates.length) * 10) / 10
    : topLevelRates.length > 0
      ? topLevelRates.at(-1)?.rate ?? null
    : labeledEvents.every(Boolean) && events.length > 0
      ? percentage(labeledEvents.filter((entry) => entry?.value === true).length, labeledEvents.length)
      : null;

  const minimumCheck = (
    id: "traceability" | "versioning" | "oversight",
    name: string,
    present: boolean[],
    threshold: number,
    evidenceNames: string,
  ): AuditCheck => {
    const measured = percentage(present.filter(Boolean).length, present.length);
    const evidencePaths = fieldsByEvent.flatMap((fields, index) =>
      present[index]
        ? fields.filter((field) => {
            if (id === "traceability") return isTraceabilityEvidence(field);
            if (id === "versioning") return isRecordedVersion(field);
            return isRecordedHumanOversight(field);
          }).map((field) => field.path)
        : [],
    );
    const status: AuditStatus = measured === null ? "not-evidenced" : measured >= threshold ? "pass" : "fail";
    return {
      id,
      name,
      status,
      measured,
      threshold,
      direction: "minimum",
      summary: `${shortPercentage(measured)} of entries are identified${evidenceNames}.`,
      evidencePaths,
      message: status === "not-evidenced"
        ? "No log entries were available to evaluate."
        : `${shortPercentage(measured)} observed; at least ${threshold}% required.`,
    };
  };

  const hallucinationStatus: AuditStatus = measuredHallucinationRate === null
    ? "not-evidenced"
    : measuredHallucinationRate <= thresholds.hallucinationMax
      ? "pass"
      : "fail";
  const completeLabels = labeledEvents.every(Boolean) && events.length > 0;
  const rateSummary = measuredHallucinationRate === null
    ? "No complete, entry-level hallucination measurement was present."
    : `${shortPercentage(measuredHallucinationRate)} measured against ${thresholds.hallucinationMax}% maximum.`;

  return [
    minimumCheck("traceability", "Traceability", traced, thresholds.traceabilityMin, " with a stable ID or timestamp"),
    minimumCheck("versioning", "Versioning", versioned, thresholds.versioningMin, " with a model or agent version"),
    {
      id: "hallucinations",
      name: "Hallucination rate",
      status: hallucinationStatus,
      measured: measuredHallucinationRate,
      threshold: thresholds.hallucinationMax,
      direction: "maximum",
      summary: rateSummary,
      evidencePaths: labeledEvents.flatMap((entry) => entry?.path ?? []).concat(hallucinationPaths),
      message: measuredHallucinationRate === null
        ? "Not evidenced; this report will not invent a hallucination measurement."
        : rateSummary,
    },
    minimumCheck("oversight", "Human oversight", oversight, thresholds.oversightMin, " with explicit review or approval fields"),
  ];
}

export function auditOpinion(checks: AuditCheck[]): { title: string; explanation: string } {
  const failures = checks.filter((check) => check.status === "fail").length;
  const unevidenced = checks.filter((check) => check.status === "not-evidenced").length;
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
    explanation: "All four checks met the selected thresholds. This opinion applies only to the log supplied and is not an independent certification.",
  };
}

export function formatEvidencePath(path: string): string {
  return path.replace(/^\$\.?/, "").replace(/\[(\d+)\]/g, (_match, index: string) => ` › entry ${Number(index) + 1}`).replace(/\./g, " › ") || "Run metadata";
}