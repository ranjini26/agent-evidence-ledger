import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  auditOpinion,
  extractAuditEvents,
  scoreAudit,
} from "@/lib/agent-ledger";

describe("AgentLedger evidence checks", () => {
  it("distinguishes a missing hallucination measurement from a zero rate", () => {
    const events = extractAuditEvents([
      { event_id: "evt-1", timestamp: "2026-11-18T09:00:00Z", model_version: "v2", human_review: true },
    ]);
    const checks = scoreAudit(events);
    const hallucinations = checks.find((check) => check.id === "hallucinations");

    expect(hallucinations?.measured).toBeNull();
    expect(hallucinations?.status).toBe("not-evidenced");
    expect(auditOpinion(checks).title).toBe("Inconclusive — evidence is incomplete");
  });

  it("meets the default 95%, 90%, 5%, and 10% thresholds at their exact boundaries", () => {
    expect(DEFAULT_THRESHOLDS).toEqual({
      traceabilityMin: 95,
      versioningMin: 90,
      hallucinationMax: 5,
      oversightMin: 10,
    });

    const events = extractAuditEvents(Array.from({ length: 20 }, (_unused, index) => ({
      ...(index < 19 ? { event_id: `entry-${index}` } : {}),
      ...(index < 18 ? { model_version: "agent-v3" } : {}),
      is_hallucination: index === 0,
      ...(index < 2 ? { human_review: true } : {}),
    })));
    const checks = scoreAudit(events);

    expect(checks.map(({ status }) => status)).toEqual(["pass", "pass", "pass", "pass"]);
    expect(checks.map(({ measured }) => measured)).toEqual([95, 90, 5, 10]);
  });

  it("re-scores every check when customized thresholds change", () => {
    const events = extractAuditEvents(Array.from({ length: 20 }, (_unused, index) => ({
      ...(index < 18 ? { event_id: `entry-${index}` } : {}),
      ...(index < 17 ? { model_version: "agent-v3" } : {}),
      is_hallucination: index < 2,
      ...(index < 1 ? { human_review: true } : {}),
    })));
    const result = scoreAudit(events, {
      traceabilityMin: 90,
      versioningMin: 80,
      hallucinationMax: 10,
      oversightMin: 5,
    });

    expect(result.map(({ status }) => status)).toEqual(["pass", "pass", "pass", "pass"]);
    expect(result.map(({ measured }) => measured)).toEqual([90, 85, 10, 5]);
  });

  it("links each finding to the exact JSON source field", () => {
    const events = extractAuditEvents({
      run_id: "run-1",
      events: [
        { event_id: "evt-1", model: "agent-v2", human_approved: true },
        { event_id: "evt-2", model: "agent-v2", is_hallucination: false },
      ],
    });
    const checks = scoreAudit(events);

    expect(events.map(({ path }) => path)).toEqual(["$.events[0]", "$.events[1]"]);
    expect(checks.find(({ id }) => id === "traceability")?.evidencePaths).toContain(
      "$.events[0].event_id",
    );
    expect(checks.find(({ id }) => id === "oversight")?.evidencePaths).toEqual([
      "$.events[0].human_approved",
    ]);
    expect(checks.find(({ id }) => id === "hallucinations")?.evidencePaths).toContain(
      "$.events[1].is_hallucination",
    );
  });

  it("does not treat false IDs, dates, or version placeholders as evidence", () => {
    const events = extractAuditEvents([
      { event_id: false, timestamp: "unknown", model_version: "unversioned", human_review: false },
    ]);
    const checks = scoreAudit(events);

    expect(checks.map(({ status }) => status)).toEqual([
      "fail",
      "fail",
      "not-evidenced",
      "fail",
    ]);
    expect(checks.find(({ id }) => id === "traceability")?.evidencePaths).toEqual([]);
  });

  it("requires an explicit usable event list and rejects scalar input", () => {
    expect(extractAuditEvents({ events: [] })).toEqual([]);
    expect(() => extractAuditEvents("not a run log")).toThrow(
      "Upload a JSON object or an array of log entries.",
    );
  });
});