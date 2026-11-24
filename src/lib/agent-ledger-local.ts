import type { Json } from "@/integrations/supabase/types";
import {
  DEFAULT_THRESHOLDS,
  SAMPLE_RUNS,
  auditOpinion,
  evaluateRunOffline,
  parseTrace,
  type AuditThresholds,
  type ControlResult,
  LedgerConflictError,
  appendToLedger,
  type LedgerEntryKind,
  type LedgerRecord,
  type LedgerStore,
} from "@/lib/audit";
import type { Tables } from "@/integrations/supabase/types";

export type GuestAuditRun = Tables<"audit_runs">;

const DATABASE_NAME = "agentledger-device-tests";
const STORE_NAME = "audits";
const LEDGER_STORE = "ledger";
const DATABASE_VERSION = 2;
export const GUEST_THRESHOLDS_KEY = "agentledger:device-test-thresholds";
export const GUEST_DEMO_SEEDED_KEY = "agentledger:sample-audits-seeded";

interface ThresholdStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readGuestThresholds(storage: ThresholdStorage): AuditThresholds {
  try {
    const serialized = storage.getItem(GUEST_THRESHOLDS_KEY);
    if (!serialized) return { ...DEFAULT_THRESHOLDS };
    const parsed: unknown = JSON.parse(serialized);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULT_THRESHOLDS };
    }
    const values = parsed as Partial<AuditThresholds>;
    return {
      traceabilityMin: readThreshold(values.traceabilityMin, DEFAULT_THRESHOLDS.traceabilityMin),
      versioningMin: readThreshold(values.versioningMin, DEFAULT_THRESHOLDS.versioningMin),
      hallucinationMax: readThreshold(values.hallucinationMax, DEFAULT_THRESHOLDS.hallucinationMax),
      oversightMin: readThreshold(values.oversightMin, DEFAULT_THRESHOLDS.oversightMin),
      groundednessMin: readThreshold(values.groundednessMin, DEFAULT_THRESHOLDS.groundednessMin),
    };
  } catch {
    return { ...DEFAULT_THRESHOLDS };
  }
}

export function writeGuestThresholds(storage: ThresholdStorage, thresholds: AuditThresholds): void {
  storage.setItem(GUEST_THRESHOLDS_KEY, JSON.stringify(thresholds));
}

export function createGuestAuditRun(
  filename: string,
  source: Json,
  checks: ControlResult[],
  runName: string,
  thresholds: AuditThresholds,
  id: string,
  createdAt: string,
): GuestAuditRun {
  return {
    id: `local-${id}`,
    user_id: "device-only",
    run_name: runName,
    source_filename: filename,
    storage_path: `device-only://${id}.json`,
    source_log: source,
    checks: JSON.parse(JSON.stringify(checks)) as Json,
    thresholds: JSON.parse(JSON.stringify(thresholds)) as Json,
    opinion: auditOpinion(checks).title,
    event_count: parseTrace(source).steps.length,
    created_at: createdAt,
  };
}

export function createGuestDemoAudits(now = new Date()): GuestAuditRun[] {
  return SAMPLE_RUNS.map((fixture, index) => {
    const source = JSON.parse(JSON.stringify(fixture.trace)) as Json;
    const checks = evaluateRunOffline(parseTrace(source), DEFAULT_THRESHOLDS);
    const createdAt = new Date(now.getTime() - index * 24 * 60 * 60 * 1000).toISOString();

    return createGuestAuditRun(
      `${fixture.id}.json`,
      source,
      checks,
      fixture.label,
      DEFAULT_THRESHOLDS,
      `demo-${fixture.id}`,
      createdAt,
    );
  });
}

export async function ensureGuestDemoAudits(storage: ThresholdStorage): Promise<GuestAuditRun[]> {
  const existing = await loadGuestAudits();
  if (storage.getItem(GUEST_DEMO_SEEDED_KEY) === "true") return existing;

  const existingIds = new Set(existing.map((run) => run.id));
  const missingSamples = createGuestDemoAudits().filter((run) => !existingIds.has(run.id));
  for (const sample of missingSamples) {
    await saveGuestAudit(sample);
    await recordRunInLedger(sample, "audit_recorded");
  }
  storage.setItem(GUEST_DEMO_SEEDED_KEY, "true");
  return missingSamples.length > 0 ? loadGuestAudits() : existing;
}

export function isGuestAuditRun(run: GuestAuditRun): boolean {
  return run.storage_path.startsWith("device-only://");
}

export function isGuestDemoAuditRun(run: GuestAuditRun): boolean {
  return run.id.startsWith("local-demo-");
}

function openGuestDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("This browser does not support on-device audit storage."));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
      // v2: append-only, hash-chained audit ledger keyed by record index.
      if (!request.result.objectStoreNames.contains(LEDGER_STORE)) {
        request.result.createObjectStore(LEDGER_STORE, { keyPath: "index" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open on-device audit storage."));
    request.onblocked = () =>
      reject(
        new Error(
          "On-device audit storage is busy in another tab. Close duplicate tabs and try again.",
        ),
      );
  });
}

export async function loadGuestAudits(): Promise<GuestAuditRun[]> {
  const database = await openGuestDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).getAll() as IDBRequest<GuestAuditRun[]>;
      request.onsuccess = () =>
        resolve(request.result.sort((a, b) => b.created_at.localeCompare(a.created_at)));
      request.onerror = () =>
        reject(request.error ?? new Error("Could not read on-device audits."));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Could not read on-device audits."));
    });
  } finally {
    database.close();
  }
}

export async function saveGuestAudit(run: GuestAuditRun): Promise<void> {
  const database = await openGuestDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(run);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Could not save the on-device audit."));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Could not save the on-device audit."));
    });
  } finally {
    database.close();
  }
}

export async function deleteGuestAudit(id: string): Promise<void> {
  const database = await openGuestDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Could not delete the on-device audit."));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Could not delete the on-device audit."));
    });
  } finally {
    database.close();
  }
}

function readThreshold(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : fallback;
}
// ---------------------------------------------------------------------------
// Ledger (IndexedDB, on this device only)
// ---------------------------------------------------------------------------

function ledgerTransaction<T>(
  mode: IDBTransactionMode,
  run: (
    store: IDBObjectStore,
    resolve: (value: T) => void,
    reject: (error: unknown) => void,
  ) => void,
): Promise<T> {
  return openGuestDatabase().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(LEDGER_STORE, mode);
        transaction.oncomplete = () => database.close();
        transaction.onabort = () => {
          database.close();
          reject(transaction.error ?? new Error("The ledger transaction was aborted."));
        };
        run(transaction.objectStore(LEDGER_STORE), resolve, reject);
      }),
  );
}

export const indexedDbLedgerStore: LedgerStore = {
  last: () =>
    ledgerTransaction<LedgerRecord | null>("readonly", (store, resolve, reject) => {
      const request = store.openCursor(null, "prev");
      request.onsuccess = () =>
        resolve((request.result?.value as LedgerRecord | undefined) ?? null);
      request.onerror = () => reject(request.error);
    }),
  add: (record) =>
    ledgerTransaction<void>("readwrite", (store, resolve, reject) => {
      const request = store.add(record);
      request.onsuccess = () => resolve();
      request.onerror = (event) => {
        event.preventDefault();
        reject(
          request.error?.name === "ConstraintError" ? new LedgerConflictError() : request.error,
        );
      };
    }),
};

/** Every ledger record on this device, oldest first. */
export function loadLedgerRecords(): Promise<LedgerRecord[]> {
  return ledgerTransaction<LedgerRecord[]>("readonly", (store, resolve, reject) => {
    const request = store.getAll() as IDBRequest<LedgerRecord[]>;
    request.onsuccess = () => resolve(request.result.sort((a, b) => a.index - b.index));
    request.onerror = () => reject(request.error);
  });
}

/** Append a record for a run that was saved ("audit_recorded") or deleted ("audit_deleted"). */
export function recordRunInLedger(
  run: GuestAuditRun,
  kind: LedgerEntryKind,
): Promise<LedgerRecord> {
  return appendToLedger(indexedDbLedgerStore, {
    kind,
    recordedAt: new Date().toISOString(),
    run: {
      id: run.id,
      name: run.run_name,
      sourceFilename: run.source_filename,
      eventCount: run.event_count,
      createdAt: run.created_at,
    },
    source: run.source_log,
    thresholds: run.thresholds as unknown as AuditThresholds,
    opinion: run.opinion,
    results: kind === "audit_recorded" ? (run.checks as unknown as ControlResult[]) : [],
  });
}
