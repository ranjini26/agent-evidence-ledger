import type { Json } from "@/integrations/supabase/types";
import {
  DEFAULT_THRESHOLDS,
  auditOpinion,
  extractAuditEvents,
  scoreAudit,
  type AuditCheck,
  type AuditThresholds,
} from "@/lib/agent-ledger";
import type { Tables } from "@/integrations/supabase/types";

export type GuestAuditRun = Tables<"audit_runs">;

const DATABASE_NAME = "agentledger-device-tests";
const STORE_NAME = "audits";
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
  checks: AuditCheck[],
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
    event_count: extractAuditEvents(source).length,
    created_at: createdAt,
  };
}

export function createGuestDemoAudits(now = new Date()): GuestAuditRun[] {
  const scenarios = [
    { id: "complete-evidence", name: "SAMPLE · Well-governed support run", traceable: 10, versioned: 10, hallucinations: 0, reviewed: 2 },
    { id: "traceability-gap", name: "SAMPLE · Untracked tool execution", traceable: 7, versioned: 10, hallucinations: 0, reviewed: 2 },
    { id: "version-drift", name: "SAMPLE · Model version drift", traceable: 10, versioned: 8, hallucinations: 0, reviewed: 2 },
    { id: "high-hallucination-rate", name: "SAMPLE · High hallucination rate", traceable: 10, versioned: 10, hallucinations: 2, reviewed: 2 },
    { id: "oversight-gap", name: "SAMPLE · Human review missing", traceable: 10, versioned: 10, hallucinations: 0, reviewed: 0 },
    { id: "hallucination-not-measured", name: "SAMPLE · Hallucination evidence missing", traceable: 10, versioned: 10, hallucinations: null, reviewed: 2 },
  ] as const;

  return scenarios.map((scenario, index) => {
    const events = Array.from({ length: 10 }, (_unused, eventIndex) => ({
      ...(eventIndex < scenario.traceable ? { event_id: `${scenario.id}-${eventIndex + 1}` } : {}),
      ...(eventIndex < scenario.versioned ? { model_version: "agent-v3.2" } : {}),
      ...(scenario.hallucinations === null ? {} : { is_hallucination: eventIndex < scenario.hallucinations }),
      ...(eventIndex < scenario.reviewed ? { human_review: true } : {}),
    }));
    const source = { run_id: `sample-${scenario.id}`, scenario: scenario.name, events } as Json;
    const checks = scoreAudit(extractAuditEvents(source), DEFAULT_THRESHOLDS, source);
    const createdAt = new Date(now.getTime() - index * 24 * 60 * 60 * 1000).toISOString();

    return createGuestAuditRun(
      `${scenario.id}.json`,
      source,
      checks,
      scenario.name,
      DEFAULT_THRESHOLDS,
      `demo-${scenario.id}`,
      createdAt,
    );
  });
}

export async function ensureGuestDemoAudits(storage: ThresholdStorage): Promise<GuestAuditRun[]> {
  const existing = await loadGuestAudits();
  if (storage.getItem(GUEST_DEMO_SEEDED_KEY) === "true") return existing;

  const existingIds = new Set(existing.map((run) => run.id));
  const missingSamples = createGuestDemoAudits().filter((run) => !existingIds.has(run.id));
  for (const sample of missingSamples) await saveGuestAudit(sample);
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
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open on-device audit storage."));
    request.onblocked = () => reject(new Error("On-device audit storage is busy in another tab. Close duplicate tabs and try again."));
  });
}

export async function loadGuestAudits(): Promise<GuestAuditRun[]> {
  const database = await openGuestDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).getAll() as IDBRequest<GuestAuditRun[]>;
      request.onsuccess = () => resolve(request.result.sort((a, b) => b.created_at.localeCompare(a.created_at)));
      request.onerror = () => reject(request.error ?? new Error("Could not read on-device audits."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Could not read on-device audits."));
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
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not save the on-device audit."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Could not save the on-device audit."));
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
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not delete the on-device audit."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Could not delete the on-device audit."));
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