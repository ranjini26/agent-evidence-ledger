import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { extractAuditEvents, type AuditCheck, type AuditThresholds } from "@/lib/agent-ledger";
import {
  createGuestAuditRun,
  deleteGuestAudit,
  isGuestAuditRun,
  loadGuestAudits,
  readGuestThresholds,
  saveGuestAudit,
  writeGuestThresholds,
} from "@/lib/agent-ledger-local";
import type { Json, Tables } from "@/integrations/supabase/types";

export type AuditRun = Tables<"audit_runs">;

interface AuditLedgerContextValue {
  email: string | null;
  runs: AuditRun[];
  loadingRuns: boolean;
  thresholds: AuditThresholds;
  error: string;
  setThresholds: (thresholds: AuditThresholds) => void;
  clearError: () => void;
  importRun: (filename: string, log: Json, checks: AuditCheck[], runName: string) => Promise<AuditRun>;
  removeRun: (run: AuditRun) => Promise<void>;
  signOut: () => Promise<void>;
}

const DEFAULT_THRESHOLDS: AuditThresholds = {
  traceabilityMin: 95,
  versioningMin: 90,
  hallucinationMax: 5,
  oversightMin: 10,
};

const TEMPORARY_DEVICE_ONLY_TEST_MODE = true;

const LedgerContext = createContext<AuditLedgerContextValue | null>(null);

export function useAgentLedger(): AuditLedgerContextValue {
  const value = useContext(LedgerContext);
  if (!value) throw new Error("AgentLedger must be used inside its app provider.");
  return value;
}

export function LedgerProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState<string | null>(null);
  const [runs, setRuns] = useState<AuditRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [thresholds, setThresholdsState] = useState(DEFAULT_THRESHOLDS);
  const [error, setError] = useState("");

  const refreshRuns = useCallback(async () => {
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) {
      setEmail(null);
      setRuns([]);
      setThresholdsState(DEFAULT_THRESHOLDS);
      setLoadingRuns(false);
      return;
    }

    setEmail(userData.user.email ?? null);
    setLoadingRuns(true);
    const { data, error: runsError } = await supabase
      .from("audit_runs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);

    if (runsError) {
      setError(runsError.message);
      setRuns([]);
    } else {
      const nextRuns = data ?? [];
      setRuns(nextRuns);
      const lastThresholds = nextRuns[0]?.thresholds;
      if (lastThresholds && typeof lastThresholds === "object" && !Array.isArray(lastThresholds)) {
        const saved = lastThresholds as Partial<AuditThresholds>;
        setThresholdsState((current) => ({
          traceabilityMin: Number(saved.traceabilityMin ?? current.traceabilityMin),
          versioningMin: Number(saved.versioningMin ?? current.versioningMin),
          hallucinationMax: Number(saved.hallucinationMax ?? current.hallucinationMax),
          oversightMin: Number(saved.oversightMin ?? current.oversightMin),
        }));
      }
    }
    setLoadingRuns(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const restoreGuestWorkspace = async () => {
      if (TEMPORARY_DEVICE_ONLY_TEST_MODE) {
        try {
          const [guestRuns, savedThresholds] = await Promise.all([
            loadGuestAudits(),
            Promise.resolve(readGuestThresholds(window.localStorage)),
          ]);
          if (!cancelled) {
            setRuns(guestRuns);
            setThresholdsState(savedThresholds);
          }
        } catch (guestError) {
          if (!cancelled) {
            setError(guestError instanceof Error ? guestError.message : "Could not open the device-only test workspace.");
            setRuns([]);
          }
        } finally {
          if (!cancelled) {
            setEmail(null);
            setLoadingRuns(false);
          }
        }
        return;
      }
      const { data } = await supabase.auth.getUser();
      if (cancelled) return;
      if (data.user) {
        await refreshRuns();
        return;
      }
      try {
        const [guestRuns, savedThresholds] = await Promise.all([
          loadGuestAudits(),
          Promise.resolve(readGuestThresholds(window.localStorage)),
        ]);
        if (!cancelled) {
          setRuns(guestRuns);
          setThresholdsState(savedThresholds);
        }
      } catch (guestError) {
        if (!cancelled) {
          setError(guestError instanceof Error ? guestError.message : "Could not open the device-only test workspace.");
          setRuns([]);
        }
      } finally {
        if (!cancelled) {
          setEmail(null);
          setLoadingRuns(false);
        }
      }
    };
    void restoreGuestWorkspace();
    const onAuthTransition = () => {
      if (TEMPORARY_DEVICE_ONLY_TEST_MODE) return;
      window.setTimeout(() => {
        void (async () => {
          const { data } = await supabase.auth.getUser();
          if (data.user) {
            await refreshRuns();
          } else {
            try {
              const [guestRuns, guestThresholds] = await Promise.all([
                loadGuestAudits(),
                Promise.resolve(readGuestThresholds(window.localStorage)),
              ]);
              setRuns(guestRuns);
              setThresholdsState(guestThresholds);
              setEmail(null);
              setLoadingRuns(false);
            } catch {
              setRuns([]);
              setEmail(null);
              setLoadingRuns(false);
            }
          }
        })();
      }, 0);
    };
    window.addEventListener("agentledger:auth-transition", onAuthTransition);
    return () => {
      cancelled = true;
      window.removeEventListener("agentledger:auth-transition", onAuthTransition);
    };
  }, [refreshRuns]);

  const setThresholds = useCallback((next: AuditThresholds) => {
    setThresholdsState(next);
    try {
      if (TEMPORARY_DEVICE_ONLY_TEST_MODE || !email) writeGuestThresholds(window.localStorage, next);
    } catch {
      setError("This browser could not save test thresholds on this device.");
    }
  }, [email]);

  const importRun = useCallback(
    async (filename: string, log: Json, checks: AuditCheck[], runName: string) => {
      setError("");
      if (TEMPORARY_DEVICE_ONLY_TEST_MODE) {
        const id = crypto.randomUUID();
        const localRun = createGuestAuditRun(
          filename,
          log,
          checks,
          runName,
          thresholds,
          id,
          new Date().toISOString(),
        );
        await saveGuestAudit(localRun);
        setRuns((current) => [localRun, ...current.filter((run) => run.id !== localRun.id)]);
        return localRun;
      }
      const { data: userData, error: authError } = await supabase.auth.getUser();
      if (!userData.user && !authError) {
        const id = crypto.randomUUID();
        const localRun = createGuestAuditRun(
          filename,
          log,
          checks,
          runName,
          thresholds,
          id,
          new Date().toISOString(),
        );
        await saveGuestAudit(localRun);
        setRuns((current) => [localRun, ...current.filter((run) => run.id !== localRun.id)]);
        return localRun;
      }
      if (authError || !userData.user) throw new Error("Could not verify account status. Please try again.");
      const storagePath = `${userData.user.id}/${crypto.randomUUID()}.json`;
      const sourceFile = new File([JSON.stringify(log, null, 2)], filename, { type: "application/json" });
      const { error: uploadError } = await supabase.storage
        .from("agentledger-run-logs")
        .upload(storagePath, sourceFile, { contentType: "application/json", upsert: false });
      if (uploadError) throw new Error(`The private log could not be saved: ${uploadError.message}`);

      const { data, error: insertError } = await supabase
        .from("audit_runs")
        .insert({
          user_id: userData.user.id,
          run_name: runName,
          source_filename: filename,
          storage_path: storagePath,
          source_log: log,
          checks: JSON.parse(JSON.stringify(checks)) as Json,
          thresholds: JSON.parse(JSON.stringify(thresholds)) as Json,
          opinion: checks.some((check) => check.status === "fail")
            ? "Qualified — findings require attention"
            : checks.some((check) => check.status === "not-evidenced")
              ? "Inconclusive — evidence is incomplete"
              : "Pass — supplied evidence meets thresholds",
          event_count: extractAuditEvents(log).length,
        })
        .select("*")
        .single();

      if (insertError || !data) {
        await supabase.storage.from("agentledger-run-logs").remove([storagePath]);
        throw new Error(`The audit could not be saved: ${insertError?.message ?? "Unknown error"}`);
      }
      setRuns((current) => [data, ...current]);
      return data;
    },
    [thresholds],
  );

  const removeRun = useCallback(async (run: AuditRun) => {
    setError("");
      if (isGuestAuditRun(run)) {
        await deleteGuestAudit(run.id);
        setRuns((current) => current.filter((item) => item.id !== run.id));
        return;
      }
      const { error: removeError } = await supabase.from("audit_runs").delete().eq("id", run.id);
      if (removeError) throw new Error(`The audit could not be deleted: ${removeError.message}`);
      await supabase.storage.from("agentledger-run-logs").remove([run.storage_path]);
      setRuns((current) => current.filter((item) => item.id !== run.id));
  }, []);

  const signOut = useCallback(async () => {
    await queryClient.cancelQueries();
    queryClient.clear();
    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) throw new Error(signOutError.message);
    setEmail(null);
    setRuns([]);
    setThresholdsState(DEFAULT_THRESHOLDS);
  }, [queryClient]);

  return (
    <LedgerContext.Provider
      value={{ email, runs, loadingRuns, thresholds, error, setThresholds, clearError: () => setError(""), importRun, removeRun, signOut }}
    >
      {children}
    </LedgerContext.Provider>
  );
}