/**
 * Append-only, hash-chained audit ledger.
 *
 * Each record holds an audited run's results (including their evidence
 * references), the engine version, the SHA-256 of the uploaded source log, and
 * the SHA-256 of the previous record. A record's own hash is SHA-256 over the
 * canonical JSON of every field except `hash`. Hashing uses the WebCrypto API
 * (`crypto.subtle`), so nothing leaves the device.
 *
 * What this detects: any edit, insertion, removal or reordering of records
 * before the newest one. What it cannot detect on its own: removal of the
 * newest records (truncation) or a wholesale rewrite of the chain, because
 * there is no external anchor or signature. Compare the head hash with one
 * you kept (it is printed on every exported report) to catch those.
 */
import type { AuditThresholds } from "./controls";
import type { ControlResult } from "./evaluate";

/** Bump when scoring, record format or hashing changes, so old records stay interpretable. */
export const AUDIT_ENGINE_VERSION = "agentledger-audit-1.0.0";
export const GENESIS_HASH = "0".repeat(64);

// ---------------------------------------------------------------------------
// Canonical JSON and hashing
// ---------------------------------------------------------------------------

/** Deterministic JSON: object keys sorted, undefined omitted, non-finite numbers rejected. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("Cannot hash a non-finite number.");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
    }
    default:
      throw new Error(`Cannot hash a value of type ${typeof value}.`);
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle)
    throw new Error(
      "This browser does not provide WebCrypto (crypto.subtle), so the ledger cannot be hashed.",
    );
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export type LedgerEntryKind = "audit_recorded" | "audit_deleted";

export interface LedgerRunSummary {
  id: string;
  name: string;
  sourceFilename: string;
  eventCount: number;
  createdAt: string;
}

/** What the caller supplies when appending. The source log is hashed, not stored. */
export interface LedgerEntry {
  kind: LedgerEntryKind;
  recordedAt: string;
  run: LedgerRunSummary;
  source: unknown;
  thresholds: AuditThresholds | null;
  opinion: string | null;
  results: ControlResult[];
}

export interface LedgerRecordBody {
  /** 1-based position in the chain. */
  index: number;
  kind: LedgerEntryKind;
  recordedAt: string;
  engineVersion: string;
  run: LedgerRunSummary & { sourceSha256: string };
  thresholds: AuditThresholds | null;
  opinion: string | null;
  /** Control results, each with its evidence references. */
  results: ControlResult[];
  previousHash: string;
}

export interface LedgerRecord extends LedgerRecordBody {
  hash: string;
}

export function recordBody(record: LedgerRecordBody): LedgerRecordBody {
  return {
    index: record.index,
    kind: record.kind,
    recordedAt: record.recordedAt,
    engineVersion: record.engineVersion,
    run: record.run,
    thresholds: record.thresholds,
    opinion: record.opinion,
    results: record.results,
    previousHash: record.previousHash,
  };
}

export function hashRecordBody(record: LedgerRecordBody): Promise<string> {
  return sha256Hex(canonicalJson(recordBody(record)));
}

export async function createLedgerRecord(
  previous: LedgerRecord | null,
  entry: LedgerEntry,
): Promise<LedgerRecord> {
  const body: LedgerRecordBody = {
    index: (previous?.index ?? 0) + 1,
    kind: entry.kind,
    recordedAt: entry.recordedAt,
    engineVersion: AUDIT_ENGINE_VERSION,
    run: { ...entry.run, sourceSha256: await sha256Hex(canonicalJson(entry.source ?? null)) },
    thresholds: entry.thresholds,
    opinion: entry.opinion,
    // A JSON round-trip so the stored record is exactly what gets hashed.
    results: JSON.parse(JSON.stringify(entry.results)) as ControlResult[],
    previousHash: previous?.hash ?? GENESIS_HASH,
  };
  return { ...body, hash: await hashRecordBody(body) };
}

/** Storage behind the ledger. `add` must refuse an index that already exists. */
export interface LedgerStore {
  last(): Promise<LedgerRecord | null>;
  add(record: LedgerRecord): Promise<void>;
}

export class LedgerConflictError extends Error {
  constructor() {
    super("Another record was appended at the same position.");
    this.name = "LedgerConflictError";
  }
}

export async function appendToLedger(
  store: LedgerStore,
  entry: LedgerEntry,
  attempts = 5,
): Promise<LedgerRecord> {
  for (let attempt = 1; ; attempt++) {
    const record = await createLedgerRecord(await store.last(), entry);
    try {
      await store.add(record);
      return record;
    } catch (error) {
      if (!(error instanceof LedgerConflictError) || attempt >= attempts) throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type LedgerBreakReason =
  "hash_mismatch" | "previous_hash_mismatch" | "index_out_of_order" | "malformed";

export interface LedgerBreak {
  /** The record's own index when readable, otherwise the position it occupies (1-based). */
  index: number;
  runId: string | null;
  runName: string | null;
  reason: LedgerBreakReason;
  explanation: string;
}

export interface LedgerVerification {
  ok: boolean;
  records: number;
  /** Hash of the newest record, when the chain is intact. */
  headHash: string | null;
  firstBreak: LedgerBreak | null;
  breaks: LedgerBreak[];
}

const HEX64 = /^[0-9a-f]{64}$/;

function isRecordShape(value: unknown): value is LedgerRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const run = record["run"] as Record<string, unknown> | undefined;
  return (
    typeof record["index"] === "number" &&
    typeof record["hash"] === "string" &&
    typeof record["previousHash"] === "string" &&
    typeof record["engineVersion"] === "string" &&
    Array.isArray(record["results"]) &&
    run !== null &&
    typeof run === "object" &&
    typeof run["id"] === "string"
  );
}

/** Recompute every hash and link, in order. Never throws on bad data; reports it. */
export async function verifyLedger(records: readonly unknown[]): Promise<LedgerVerification> {
  const breaks: LedgerBreak[] = [];
  for (let position = 0; position < records.length; position++) {
    const value = records[position];
    const expectedIndex = position + 1;
    if (!isRecordShape(value)) {
      const index =
        typeof (value as { index?: unknown } | null)?.index === "number"
          ? (value as { index: number }).index
          : expectedIndex;
      breaks.push({
        index,
        runId: null,
        runName: null,
        reason: "malformed",
        explanation: `Record #${index} is missing required fields or has the wrong types, so it cannot be verified.`,
      });
      continue;
    }
    const record = value;
    const who = {
      runId: record.run.id,
      runName: typeof record.run.name === "string" ? record.run.name : null,
    };
    const label = `record #${record.index}${who.runName ? ` (${who.runName})` : ""}`;

    if (record.index !== expectedIndex) {
      breaks.push({
        index: record.index,
        ...who,
        reason: "index_out_of_order",
        explanation: `Expected record #${expectedIndex} at this position but found ${label}: a record was removed, inserted or reordered before it.`,
      });
    }

    const previous = position === 0 ? null : records[position - 1];
    const expectedPrevious =
      position === 0 ? GENESIS_HASH : isRecordShape(previous) ? previous.hash : null;
    if (expectedPrevious !== null && record.previousHash !== expectedPrevious) {
      breaks.push({
        index: record.index,
        ...who,
        reason: "previous_hash_mismatch",
        explanation:
          position === 0
            ? `The first record, ${label}, should link to the genesis hash but links elsewhere.`
            : `${label[0]!.toUpperCase()}${label.slice(1)} links to a hash that record #${(previous as LedgerRecord).index} no longer has. Record #${(previous as LedgerRecord).index} (or an earlier record) was rewritten and re-hashed, or a record was inserted or removed.`,
      });
    }

    let recomputed: string | null = null;
    try {
      recomputed = await hashRecordBody(record);
    } catch {
      recomputed = null;
    }
    if (!HEX64.test(record.hash) || recomputed !== record.hash) {
      breaks.push({
        index: record.index,
        ...who,
        reason: "hash_mismatch",
        explanation: `The contents of ${label} no longer match its stored hash: the record was changed after it was written.`,
      });
    }
  }
  const last = records.at(-1);
  return {
    ok: breaks.length === 0,
    records: records.length,
    headHash: breaks.length === 0 && isRecordShape(last) ? last.hash : null,
    firstBreak: breaks[0] ?? null,
    breaks,
  };
}

// ---------------------------------------------------------------------------
// Displayed runs vs ledger
// ---------------------------------------------------------------------------

export interface StoredRunLike {
  id: string;
  run_name: string;
  checks: unknown;
  source_log: unknown;
  opinion: string;
}

export interface RunLedgerCheck {
  runId: string;
  runName: string;
  /** matches: the run shown equals its ledger record. not_recorded: no record (e.g. saved before the ledger existed). */
  status: "matches" | "modified_since_recorded" | "not_recorded";
  recordIndex: number | null;
}

/** Compare the runs the app displays with the latest ledger record for each. */
export async function crossCheckRuns(
  records: readonly LedgerRecord[],
  runs: readonly StoredRunLike[],
): Promise<RunLedgerCheck[]> {
  const latest = new Map<string, LedgerRecord>();
  for (const record of records)
    if (record.kind === "audit_recorded") latest.set(record.run.id, record);
  return Promise.all(
    runs.map(async (run): Promise<RunLedgerCheck> => {
      const record = latest.get(run.id);
      if (!record)
        return { runId: run.id, runName: run.run_name, status: "not_recorded", recordIndex: null };
      const same =
        canonicalJson(run.checks) === canonicalJson(record.results) &&
        run.opinion === record.opinion &&
        (await sha256Hex(canonicalJson(run.source_log ?? null))) === record.run.sourceSha256;
      return {
        runId: run.id,
        runName: run.run_name,
        status: same ? "matches" : "modified_since_recorded",
        recordIndex: record.index,
      };
    }),
  );
}
