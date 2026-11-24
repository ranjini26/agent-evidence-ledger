import { describe, expect, it } from "vitest";
import { SAMPLE_RUNS, evaluateTrace, parseTrace, readStoredResults } from "@/lib/audit";
import {
  createGuestAuditRun,
  createGuestDemoAudits,
  isGuestAuditRun,
  isGuestDemoAuditRun,
  readGuestThresholds,
} from "@/lib/agent-ledger-local";

describe("device-only guest audits", () => {
  it("keeps guest audit runs marked as device-only and reads editable local thresholds", () => {
    const values = new Map<string, string>([
      [
        "agentledger:device-test-thresholds",
        JSON.stringify({
          traceabilityMin: 88,
          versioningMin: 90,
          hallucinationMax: 5,
          oversightMin: 10,
        }),
      ],
    ]);
    const thresholds = readGuestThresholds({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    });
    const source = [{ event_id: "evt-1" }];
    const results = evaluateTrace(parseTrace(source), thresholds);
    const run = createGuestAuditRun(
      "run.json",
      source,
      results,
      "Local test",
      thresholds,
      "test-id",
      "2026-11-18T09:00:00Z",
    );

    expect(thresholds.traceabilityMin).toBe(88);
    expect(run.id).toBe("local-test-id");
    expect(isGuestAuditRun(run)).toBe(true);
    expect(run.storage_path).toBe("device-only://test-id.json");
    expect(run.event_count).toBe(1);
  });

  it("seeds one SAMPLE audit per fixture, scored by the audit module", () => {
    const samples = createGuestDemoAudits(new Date("2026-11-18T12:00:00.000Z"));

    expect(samples).toHaveLength(SAMPLE_RUNS.length);
    samples.forEach((run, index) => {
      const fixture = SAMPLE_RUNS[index]!;
      expect(run.run_name).toBe(fixture.label);
      expect(run.run_name).toMatch(/^SAMPLE · /);
      expect(run.source_log).toEqual(fixture.trace);
      expect(run.event_count).toBe(10);
      expect(
        Object.fromEntries(
          readStoredResults(run.checks).map((result) => [result.id, result.status]),
        ),
      ).toEqual({ ...fixture.expected, groundedness: "not_evidenced" });
      expect(isGuestAuditRun(run) && isGuestDemoAuditRun(run)).toBe(true);
    });
  });
});
