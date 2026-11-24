import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUDIT_ENGINE_VERSION,
  DEFAULT_THRESHOLDS,
  GENESIS_HASH,
  LedgerConflictError,
  appendToLedger,
  canonicalJson,
  crossCheckRuns,
  evaluateRunOffline,
  hashRecordBody,
  parseTrace,
  sha256Hex,
  verifyLedger,
  type LedgerEntry,
  type LedgerRecord,
  type LedgerStore,
} from "@/lib/audit";

function memoryStore(initial: LedgerRecord[] = []): LedgerStore & { records: LedgerRecord[] } {
  const records = [...initial];
  return {
    records,
    async last() {
      return records.at(-1) ?? null;
    },
    async add(record) {
      if (records.some((existing) => existing.index === record.index))
        throw new LedgerConflictError();
      records.push(record);
    },
  };
}

function entry(
  id: string,
  source: unknown = { steps: [{ step_id: `${id}-1`, model_version: "v1" }] },
): LedgerEntry {
  const results = evaluateRunOffline(parseTrace(source), DEFAULT_THRESHOLDS);
  return {
    kind: "audit_recorded",
    recordedAt: "2026-11-25T10:00:00.000Z",
    run: {
      id,
      name: `SAMPLE · ${id}`,
      sourceFilename: `${id}.json`,
      eventCount: 1,
      createdAt: "2026-11-25T09:59:00.000Z",
    },
    source,
    thresholds: DEFAULT_THRESHOLDS,
    opinion: "Inconclusive — evidence is incomplete",
    results,
  };
}

async function chainOf(count: number) {
  const store = memoryStore();
  for (let index = 0; index < count; index++)
    await appendToLedger(store, entry(`run-${index + 1}`));
  return store.records;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

afterEach(() => vi.restoreAllMocks());

describe("canonicalJson", () => {
  it("is independent of key order and omits undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } })).toBe(
      canonicalJson({ a: { d: [3, { x: 2, y: 1 }] }, b: 1 }),
    );
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("keeps array order significant", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("rejects values that have no stable JSON form", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: Infinity })).toThrow();
  });
});

describe("sha256Hex (WebCrypto)", () => {
  it("matches the FIPS 180-2 test vector", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("uses crypto.subtle", async () => {
    const digest = vi.spyOn(globalThis.crypto.subtle, "digest");
    await sha256Hex("x");
    expect(digest).toHaveBeenCalledWith("SHA-256", expect.anything());
  });
});

describe("appending records", () => {
  it("chains each record to the hash of the one before, starting from the genesis hash", async () => {
    const records = await chainOf(3);
    expect(records.map((record) => record.index)).toEqual([1, 2, 3]);
    expect(records[0]!.previousHash).toBe(GENESIS_HASH);
    expect(records[1]!.previousHash).toBe(records[0]!.hash);
    expect(records[2]!.previousHash).toBe(records[1]!.hash);
    expect(records.every((record) => /^[0-9a-f]{64}$/.test(record.hash))).toBe(true);
  });

  it("stores the results with their evidence references, the engine version and the source hash", async () => {
    const [record] = await chainOf(1);
    expect(record!.engineVersion).toBe(AUDIT_ENGINE_VERSION);
    expect(record!.results.map((result) => result.id)).toContain("traceability");
    expect(record!.results[0]!.evidence[0]).toMatchObject({ path: "$.steps[0].step_id" });
    expect(record!.run.sourceSha256).toBe(
      await sha256Hex(canonicalJson({ steps: [{ step_id: "run-1-1", model_version: "v1" }] })),
    );
    expect(record!.hash).toBe(await hashRecordBody(record!));
  });

  it("does not store the source log itself, only its hash", async () => {
    const [record] = await chainOf(1);
    expect(record).not.toHaveProperty("source");
  });

  it("retries when another tab appended the same index first", async () => {
    const store = memoryStore();
    await appendToLedger(store, entry("a"));
    let raced = false;
    const racing: LedgerStore = {
      last: store.last,
      async add(record) {
        if (!raced) {
          raced = true;
          await store.add(
            await (async () => {
              const competitor = clone(record);
              competitor.run.id = "other-tab";
              competitor.hash = await hashRecordBody(competitor);
              return competitor;
            })(),
          );
        }
        return store.add(record);
      },
    };
    const appended = await appendToLedger(racing, entry("b"));
    expect(appended.index).toBe(3);
    expect((await verifyLedger(store.records)).ok).toBe(true);
  });

  it("makes no network calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const xhr = vi.spyOn(XMLHttpRequest.prototype, "open");
    await chainOf(2);
    await verifyLedger(await chainOf(2));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhr).not.toHaveBeenCalled();
  });
});

describe("verifyLedger", () => {
  it("accepts an untouched chain and reports its head", async () => {
    const records = await chainOf(4);
    const result = await verifyLedger(records);
    expect(result).toMatchObject({
      ok: true,
      records: 4,
      headHash: records[3]!.hash,
      firstBreak: null,
    });
  });

  it("accepts an empty ledger", async () => {
    expect(await verifyLedger([])).toMatchObject({ ok: true, records: 0, headHash: null });
  });

  it("fails at the exact record whose result was edited", async () => {
    const records = clone(await chainOf(4));
    records[1]!.results[0]!.status = records[1]!.results[0]!.status === "pass" ? "fail" : "pass";
    const result = await verifyLedger(records);
    expect(result.ok).toBe(false);
    expect(result.firstBreak).toMatchObject({ index: 2, runId: "run-2", reason: "hash_mismatch" });
    expect(result.firstBreak!.explanation).toMatch(/record #2/i);
    expect(result.breaks).toHaveLength(1);
  });

  it("fails when an evidence reference is edited", async () => {
    const records = clone(await chainOf(3));
    records[2]!.results[0]!.evidence[0]!.path = "$.steps[9].step_id";
    expect((await verifyLedger(records)).firstBreak).toMatchObject({
      index: 3,
      reason: "hash_mismatch",
    });
  });

  it("fails when the engine version is edited", async () => {
    const records = clone(await chainOf(2));
    records[0]!.engineVersion = "0.0.0";
    expect((await verifyLedger(records)).firstBreak).toMatchObject({
      index: 1,
      reason: "hash_mismatch",
    });
  });

  it("fails at the next link when a record is edited and its own hash recomputed", async () => {
    const records = clone(await chainOf(4));
    records[1]!.opinion = "Pass — supplied evidence meets thresholds";
    records[1]!.hash = await hashRecordBody(records[1]!);
    const result = await verifyLedger(records);
    expect(result.ok).toBe(false);
    expect(result.firstBreak).toMatchObject({ index: 3, reason: "previous_hash_mismatch" });
    expect(result.firstBreak!.explanation).toMatch(/record #2/i);
  });

  it("fails when a record in the middle is deleted", async () => {
    const records = clone(await chainOf(4));
    records.splice(1, 1);
    const result = await verifyLedger(records);
    expect(result.firstBreak).toMatchObject({ index: 3, reason: "index_out_of_order" });
  });

  it("fails when records are reordered", async () => {
    const records = clone(await chainOf(3));
    [records[0], records[1]] = [records[1]!, records[0]!];
    expect((await verifyLedger(records)).ok).toBe(false);
  });

  it("fails when the genesis link is rewritten", async () => {
    const records = clone(await chainOf(2));
    records[0]!.previousHash = "f".repeat(64);
    expect((await verifyLedger(records)).firstBreak).toMatchObject({ index: 1 });
  });

  it("reports malformed records instead of throwing", async () => {
    const records: unknown[] = clone(await chainOf(2));
    records[1] = { index: 2, hash: 42 };
    expect((await verifyLedger(records)).firstBreak).toMatchObject({
      index: 2,
      reason: "malformed",
    });
  });

  it("cannot detect removal of the newest records on its own (documented limitation)", async () => {
    const records = await chainOf(3);
    const truncated = await verifyLedger(records.slice(0, 2));
    expect(truncated.ok).toBe(true);
    expect(truncated.headHash).not.toBe(records[2]!.hash);
  });
});

describe("crossCheckRuns", () => {
  it("flags runs changed after they were recorded, runs never recorded, and deleted runs", async () => {
    const store = memoryStore();
    const a = entry("a");
    const b = entry("b");
    await appendToLedger(store, a);
    await appendToLedger(store, b);
    await appendToLedger(store, { ...entry("c"), kind: "audit_deleted" });

    const asRun = (e: LedgerEntry) => ({
      id: e.run.id,
      run_name: e.run.name,
      checks: clone(e.results),
      source_log: e.source,
      opinion: e.opinion ?? "",
    });
    const tampered = asRun(b);
    expect(tampered.checks[0]!.status).toBe("pass");
    tampered.checks[0]!.status = "fail";
    tampered.checks[0]!.measured = 0;

    const checks = await crossCheckRuns(store.records, [asRun(a), tampered, asRun(entry("never"))]);
    expect(checks.map(({ runId, status, recordIndex }) => [runId, status, recordIndex])).toEqual([
      ["a", "matches", 1],
      ["b", "modified_since_recorded", 2],
      ["never", "not_recorded", null],
    ]);
  });
});
