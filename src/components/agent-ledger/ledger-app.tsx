import { useCallback, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, BookCheck, Check, ChevronDown,
  CircleDot, ClipboardCheck, FileCheck2, FileDown, FileJson2, Fingerprint,
  FileText, Gauge, HardDrive, KeyRound, Link2, LockKeyhole, LogOut, Printer, ShieldAlert, ShieldCheck,
  ShieldQuestion, SlidersHorizontal, Sparkles, UploadCloud, X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAgentLedger, type AuditRun } from "@/lib/agent-ledger-context";
import { isGuestAuditRun, isGuestDemoAuditRun, loadLedgerRecords } from "@/lib/agent-ledger-local";
import {
  DEFAULT_THRESHOLDS, auditOpinion, evaluateRun, formatTracePath, measuredPaths,
  parseTrace, readStoredResults, type AuditThresholds, type ControlResult,
  type ControlStatus, type TraceStep, verifyLedger, crossCheckRuns,
  type LedgerVerification, type RunLedgerCheck,
} from "@/lib/audit";
import { buildAuditReport } from "@/lib/report/audit-report";
import { renderMarkdown } from "@/lib/report/markdown";
import { renderPdf } from "@/lib/report/pdf";
import { createClaudeGroundednessJudge } from "@/lib/judge/claude-groundedness-judge";
import type { Json } from "@/integrations/supabase/types";

const controls = [
  { key: "traceabilityMin", label: "Traceability", note: "Entries with an ID or timestamp", unit: "%", icon: Fingerprint },
  { key: "versioningMin", label: "Versioning", note: "Entries with a model or agent version", unit: "%", icon: FileCheck2 },
  { key: "hallucinationMax", label: "Hallucination rate", note: "Maximum explicitly measured rate", unit: "%", icon: Sparkles },
  { key: "oversightMin", label: "Human oversight", note: "Entries recording review or approval", unit: "%", icon: ClipboardCheck },
  { key: "groundednessMin", label: "Groundedness", note: "Answer claims supported by earlier tool outputs", unit: "%", icon: BookCheck },
] as const;

const iconsByControl = {
  traceability: Fingerprint,
  versioning: FileCheck2,
  hallucinations: Sparkles,
  oversight: ClipboardCheck,
  groundedness: BookCheck,
} as const;

function formatPercent(value: number | null): string {
  return value === null ? "N/E" : `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

function formattedDate(value: string, compact = false): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat("en-GB", compact
    ? { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }
    : { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" },
  ).format(date);
}

function runChecks(run: AuditRun): ControlResult[] {
  return readStoredResults(run.checks);
}

function runSource(run: AuditRun): unknown {
  return run.source_log;
}

function runThresholds(run: AuditRun): AuditThresholds {
  const value: unknown = run.thresholds;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return DEFAULT_THRESHOLDS;
  const partial = value as Partial<AuditThresholds>;
  return {
    traceabilityMin: Number(partial.traceabilityMin ?? DEFAULT_THRESHOLDS.traceabilityMin),
    versioningMin: Number(partial.versioningMin ?? DEFAULT_THRESHOLDS.versioningMin),
    hallucinationMax: Number(partial.hallucinationMax ?? DEFAULT_THRESHOLDS.hallucinationMax),
    oversightMin: Number(partial.oversightMin ?? DEFAULT_THRESHOLDS.oversightMin),
    groundednessMin: Number(partial.groundednessMin ?? DEFAULT_THRESHOLDS.groundednessMin),
  };
}

function StatusPill({ status }: { status: ControlStatus }) {
  const label = status === "pass" ? "Pass" : status === "fail" ? "Fail" : "Not evidenced";
  const Icon = status === "pass" ? Check : status === "fail" ? X : ShieldQuestion;
  return (
    <span className={`ledger-status-${status === "pass" ? "pass" : status === "fail" ? "fail" : "unknown"} inline-flex items-center gap-1.5 border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.06em]`}>
      <Icon size={11} aria-hidden="true" />{label}
    </span>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link to="/" aria-label="AgentLedger dashboard" className="ledger-focusable inline-flex min-w-0 items-center gap-3">
      <span className="relative flex size-9 shrink-0 items-center justify-center border border-primary/40 bg-accent text-primary">
        <span className="ledger-mono text-[17px] font-semibold">A</span>
        <span className="absolute -bottom-px -right-px size-[5px] bg-primary" />
      </span>
      {!compact && (
        <span className="min-w-0">
          <span className="block truncate text-sm font-bold tracking-tight">AgentLedger</span>
          <span className="ledger-mono mt-0.5 block truncate text-[9px] tracking-[0.08em] text-muted-foreground">RUN ASSURANCE / 01</span>
        </span>
      )}
    </Link>
  );
}

function AccountPanel() {
  const { email, signOut } = useAgentLedger();
  const [busy, setBusy] = useState(false);
  if (!email) return null;

  const logout = async () => {
    setBusy(true);
    try {
      await signOut();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not sign out.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-auto border-t border-border/70 px-4 py-4">
      <span className="ledger-mono block text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Signed in</span>
      <span className="mt-2 block truncate text-xs text-foreground/90">{email}</span>
      <Button className="mt-3 w-full justify-start gap-2 text-muted-foreground hover:text-foreground" variant="ghost" size="sm" onClick={() => void logout()} disabled={busy}>
        <LogOut size={14} aria-hidden="true" /> Sign out
      </Button>
    </div>
  );
}

function AppFrame({ children, active }: { children: ReactNode; active: "dashboard" | "findings" | "report" }) {
  const { email, runs, loadingRuns, error, clearError, signOut } = useAgentLedger();
  const navItems = [
    { label: "Dashboard", path: "/" as const, active: active === "dashboard", icon: Gauge },
    ...(runs.length > 0 ? [{ label: "Findings", path: "/findings/$auditId" as const, active: active === "findings", icon: CircleDot, auditId: runs[0]?.id }] : []),
    ...(runs.length > 0 ? [{ label: "Audit report", path: "/report/$auditId" as const, active: active === "report", icon: FileCheck2, auditId: runs[0]?.id }] : []),
  ];

  return (
    <div className="ledger-shell min-h-screen bg-background text-foreground">
      <div className="ledger-app-frame mx-auto flex min-h-screen max-w-[1600px]">
        <aside className="ledger-app-sidebar hidden w-[240px] shrink-0 flex-col border-r border-border/80 bg-shell/70 md:flex">
          <div className="flex h-[77px] items-center border-b border-border/80 px-5">
            <Brand />
          </div>
          <div className="px-3 pt-6">
            <div className="ledger-mono px-3 text-[9px] uppercase tracking-[0.17em] text-muted-foreground">Workspace</div>
            <nav aria-label="Main navigation" className="mt-3 grid gap-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                return item.path === "/" ? (
                  <Link key={item.label} to={item.path} className={`flex h-10 items-center gap-3 border-l-2 px-3 text-xs font-semibold transition-colors ${item.active ? "border-primary bg-primary/5 text-foreground" : "border-transparent text-muted-foreground hover:bg-secondary/60 hover:text-foreground"}`}>
                    <Icon size={15} aria-hidden="true" />{item.label}
                    {loadingRuns && item.active && <span className="ml-auto size-1.5 animate-pulse rounded-full bg-primary" />}
                  </Link>
                ) : (
                  <Link key={item.label} to={item.path} params={{ auditId: item.auditId ?? "" }} className={`flex h-10 items-center gap-3 border-l-2 px-3 text-xs font-semibold transition-colors ${item.active ? "border-primary bg-primary/5 text-foreground" : "border-transparent text-muted-foreground hover:bg-secondary/60 hover:text-foreground"}`}>
                    <Icon size={15} aria-hidden="true" />{item.label}
                  </Link>
                );
              })}
            </nav>
          </div>
          <div className="mx-4 mt-7 border-t border-border/70 pt-5">
            <div className="flex items-center justify-between px-1">
              <span className="ledger-mono text-[9px] uppercase tracking-[0.15em] text-muted-foreground">Recent runs</span>
              <span className="ledger-mono text-[10px] text-muted-foreground">{runs.length.toString().padStart(2, "0")}</span>
            </div>
            <div className="mt-2 grid">
              {runs.slice(0, 4).map((run) => (
                <Link key={run.id} to="/findings/$auditId" params={{ auditId: run.id }} className="flex min-w-0 items-center gap-2.5 rounded-sm px-1 py-2.5 hover:bg-secondary/50">
                  <span className="size-1.5 shrink-0 rounded-full bg-primary/85" />
                  <span className="truncate text-[11px] text-muted-foreground">{run.run_name}</span>
                </Link>
              ))}
              {runs.length === 0 && !loadingRuns && <p className="px-1 py-3 text-[10px] text-muted-foreground">Your saved audits appear here.</p>}
            </div>
          </div>
          <div className="mx-4 mt-auto border-t border-border/70 py-4">
            <div className="flex items-center gap-2 px-1 text-muted-foreground">
              <LockKeyhole size={12} aria-hidden="true" />
              <span className="ledger-mono text-[9px] uppercase tracking-[0.07em]">{email ? "Private to your account" : "Test data stays on this device"}</span>
            </div>
            <AccountPanel />
          </div>
        </aside>

        <main className="ledger-app-main flex min-w-0 flex-1 flex-col">
          <header className="flex h-[68px] min-w-0 items-center justify-between border-b border-border/80 bg-background/70 px-4 sm:px-7 lg:px-9">
            <div className="flex min-w-0 items-center gap-3 md:hidden"><Brand compact /><div className="h-5 w-px shrink-0 bg-border"/><span className="ledger-mono truncate text-[10px] uppercase tracking-[0.11em] text-muted-foreground">AgentLedger</span></div>
            <div className="hidden items-center gap-2.5 md:flex"><span className="size-1.5 rounded-full bg-primary shadow-[0_0_9px_var(--color-primary)]"/><span className="ledger-mono text-[10px] tracking-[0.05em] text-muted-foreground">CONTROL REVIEW / <span className="text-foreground">ACTIVE</span></span></div>
            <div className="flex min-w-0 items-center gap-2.5">
              {email ? <span className="hidden max-w-52 truncate text-[11px] text-muted-foreground sm:block">{email}</span> : <span className="ledger-mono text-[9px] uppercase tracking-[0.08em] text-review">Device-only testing</span>}
              <span className="inline-flex size-8 shrink-0 items-center justify-center border border-border/80 bg-secondary/40 text-muted-foreground" aria-label={email ? "Signed in" : "Device-only test mode"}>{email ? <ShieldCheck size={15} aria-hidden="true"/> : <HardDrive size={14} aria-hidden="true"/>}</span>
              {email && <Button className="inline-flex sm:hidden" size="icon" variant="ghost" aria-label="Sign out" onClick={() => void signOut()}><LogOut size={15}/></Button>}
            </div>
          </header>
          {error && <div role="alert" className="flex items-center justify-between gap-4 border-b border-coral/30 bg-coral/5 px-4 py-3 text-xs text-coral sm:px-7"><span>{error}</span><button className="cursor-pointer p-1" aria-label="Dismiss error" onClick={clearError}><X size={14}/></button></div>}
          <div className="min-w-0 flex-1 px-4 py-6 sm:px-7 sm:py-8 lg:px-10">{children}</div>
          <footer className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-border/70 px-4 py-4 sm:px-7 lg:px-10">
            <span className="ledger-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">AgentLedger <span className="mx-1 text-border">/</span> Evidence, not assumptions.</span>
            <span className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">{email ? <><LockKeyhole size={11} aria-hidden="true"/> Logs are private to their owner</> : <><HardDrive size={11} aria-hidden="true"/> Test logs stay on this device</>}</span>
          </footer>
        </main>
      </div>
      <div className="ledger-screen border-t border-border/80 bg-shell/95 px-3 py-2 md:hidden print:hidden">
        <nav aria-label="Mobile navigation" className="flex items-center justify-around gap-2">
          <Link to="/" className={`flex min-h-10 flex-1 items-center justify-center gap-2 text-[10px] font-semibold ${active === "dashboard" ? "text-primary" : "text-muted-foreground"}`}><Gauge size={14} aria-hidden="true"/> Dashboard</Link>
          {runs[0] && <Link to="/findings/$auditId" params={{ auditId: runs[0].id }} className={`flex min-h-10 flex-1 items-center justify-center gap-2 text-[10px] font-semibold ${active === "findings" ? "text-primary" : "text-muted-foreground"}`}><CircleDot size={14} aria-hidden="true"/> Findings</Link>}
          {runs[0] && <Link to="/report/$auditId" params={{ auditId: runs[0].id }} className={`flex min-h-10 flex-1 items-center justify-center gap-2 text-[10px] font-semibold ${active === "report" ? "text-primary" : "text-muted-foreground"}`}><FileCheck2 size={14} aria-hidden="true"/> Report</Link>}
        </nav>
      </div>
    </div>
  );
}

function EvidenceMetric({ value, total, icon: Icon, label }: { value: string; total: string; icon: typeof FileJson2; label: string }) {
  return <div className="group relative min-w-0 border-r border-border/70 px-3 py-4 last:border-r-0 sm:px-5 sm:py-5"><div className="flex items-start justify-between gap-2"><span className="ledger-mono truncate text-[8px] uppercase tracking-[0.13em] text-muted-foreground sm:text-[9px]">{label}</span><Icon size={13} className="shrink-0 text-muted-foreground/75" aria-hidden="true"/></div><div className="ledger-mono mt-3 flex items-baseline gap-2 sm:mt-4"><strong className="text-lg font-medium tracking-tight sm:text-2xl">{value}</strong><span className="truncate text-[9px] text-muted-foreground sm:text-[10px]">{total}</span></div></div>;
}

function ThresholdEditor({
  thresholds, onChange, disabled = false,
}: { thresholds: AuditThresholds; onChange: (next: AuditThresholds) => void; disabled?: boolean }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3 border-b border-border/70 pb-3">
        <div className="flex items-center gap-2"><SlidersHorizontal size={14} className="text-primary"/><h3 className="text-xs font-bold">Control thresholds</h3></div>
        <span className="ledger-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">Editable</span>
      </div>
      <div className="mt-2 grid">
        {controls.map(({ key, label, note, unit, icon: Icon }) => (
          <div key={key} className="flex items-center gap-3 border-b border-border/60 py-3 last:border-b-0 sm:gap-4">
            <span className="flex size-8 shrink-0 items-center justify-center border border-border bg-secondary/35 text-muted-foreground"><Icon size={14}/></span>
            <div className="min-w-0 flex-1"><label htmlFor={`threshold-${key}`} className="block text-xs font-semibold">{label}</label><p className="mt-0.5 hidden text-[9px] leading-relaxed text-muted-foreground sm:block">{note}</p></div>
            <div className="flex w-[86px] shrink-0 items-center gap-2 border border-input bg-background/70 px-2.5"><Input id={`threshold-${key}`} type="number" min="0" max="100" step="1" disabled={disabled} aria-label={`${label} threshold in percent`} className="ledger-mono h-9 border-0 bg-transparent px-0 text-right text-[13px] tabular-nums shadow-none focus-visible:ring-0" value={thresholds[key]} onChange={(event) => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) onChange({ ...thresholds, [key]: Math.min(100, Math.max(0, value)) }); }}/><span className="ledger-mono text-[10px] text-muted-foreground">{unit}</span></div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[9px] leading-relaxed text-muted-foreground">Defaults: 95% traceability, 90% versioning, 5% maximum measured hallucinations, and 10% human review. Settings apply to new audits and stay with each report.</p>
    </div>
  );
}

function LatestCheckList({ run }: { run: AuditRun }) {
  const checks = runChecks(run);
  return (
    <section className="border-t border-border/80 bg-card/35 px-4 py-4 sm:px-5 sm:py-5">
      <div className="flex items-center justify-between gap-3"><h3 className="flex items-center gap-2 text-xs font-bold"><ClipboardCheck size={14} className="text-primary"/> Control checklist</h3><Link to="/findings/$auditId" params={{ auditId: run.id }} className="flex items-center gap-1.5 text-[10px] font-semibold text-primary hover:text-foreground">All findings <ArrowUpRight size={12}/></Link></div>
      <div className="mt-3 grid grid-cols-1 gap-px border border-border/70 bg-border/70 sm:grid-cols-2">
        {checks.map((check) => {const Icon = iconsByControl[check.id]; return <Link key={check.id} to="/findings/$auditId" params={{ auditId: run.id }} className="flex min-w-0 items-center gap-3 bg-card px-3 py-3 hover:bg-secondary/35"><Icon className="shrink-0 text-muted-foreground" size={14}/><span className="min-w-0 flex-1 truncate text-[11px] font-medium">{check.name}</span><StatusPill status={check.status}/></Link>;})}
      </div>
    </section>
  );
}

function GroundednessKeyField({ disabled }: { disabled: boolean }) {
  const { anthropicKey, setAnthropicKey } = useAgentLedger();
  return (
    <div className="mt-4 border border-border/60 bg-card/25 px-4 py-3">
      <label htmlFor="anthropic-key" className="flex items-center gap-2 text-[11px] font-semibold"><KeyRound size={13} className="text-primary" aria-hidden="true"/> Anthropic API key <span className="font-normal text-muted-foreground">(optional, for the groundedness check)</span></label>
      <div className="mt-2 flex gap-2">
        <Input id="anthropic-key" type="password" autoComplete="off" spellCheck={false} disabled={disabled} value={anthropicKey} onChange={(event) => setAnthropicKey(event.target.value.trim())} placeholder="sk-ant-…" className="h-8 rounded-none text-xs"/>
        {anthropicKey && <Button type="button" variant="outline" className="h-8 rounded-none text-[10px]" disabled={disabled} onClick={() => setAnthropicKey("")}>Forget key</Button>}
      </div>
      <p className="mt-2 text-[9px] leading-relaxed text-muted-foreground">Kept in this tab's memory only. It is never saved, logged or sent to AgentLedger; it is forgotten when you reload. With a key, each model answer and the tool outputs before it are sent from your browser to Anthropic's API and billed to your key. Without a key, groundedness is reported as not evidenced.</p>
    </div>
  );
}

function MethodLine({ method }: { method: NonNullable<ControlResult["method"]> }) {
  return <span className="ledger-mono">Method: {method.name} · Model: {method.model ?? "not run (no API key)"} · Prompt: {method.promptVersion}</span>;
}

function JudgedDetails({ check }: { check: ControlResult }) {
  if (!check.method) return null;
  const flagged = (check.answers ?? []).flatMap((answer) => answer.claims.filter((claim) => claim.verdict !== "supported").map((claim) => ({ answer, claim })));
  const failed = (check.answers ?? []).filter((answer) => answer.error);
  return (
    <div className="border-t border-border/70 px-3 py-3 text-[9px] leading-relaxed text-muted-foreground sm:px-4">
      <p><MethodLine method={check.method}/></p>
      {flagged.length > 0 && <ul className="mt-2 grid gap-1.5">{flagged.map(({ answer, claim }, index) => <li key={index} className="flex flex-wrap gap-x-2"><a href={`#source-entry-${answer.step}`} className="font-semibold text-primary">Step {answer.step + 1}</a><span className="text-coral">{claim.verdict}</span><span className="text-foreground">“{claim.claim}”</span><span>{claim.explanation}</span></li>)}</ul>}
      {failed.length > 0 && <p className="mt-2 text-review">Not judged: {failed.map((answer) => `step ${answer.step + 1} (${answer.error})`).join("; ")}</p>}
    </div>
  );
}

function LedgerVerifier() {
  const { runs } = useAgentLedger();
  const [state, setState] = useState<{ verification: LedgerVerification; runChecks: RunLedgerCheck[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const [failure, setFailure] = useState("");
  const verify = async () => {
    setChecking(true);
    setFailure("");
    try {
      const records = await loadLedgerRecords();
      const verification = await verifyLedger(records);
      const runChecks = await crossCheckRuns(records, runs);
      setState({ verification, runChecks });
    } catch (error) {
      setState(null);
      setFailure(error instanceof Error ? error.message : "The ledger could not be read.");
    } finally {
      setChecking(false);
    }
  };
  const modified = state?.runChecks.filter((check) => check.status === "modified_since_recorded") ?? [];
  const unrecorded = state?.runChecks.filter((check) => check.status === "not_recorded") ?? [];
  const v = state?.verification;
  return (
    <section className="mt-6 border border-border bg-card/40 px-4 py-4" aria-labelledby="ledger-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 id="ledger-heading" className="flex items-center gap-2 text-sm font-bold"><Link2 size={14} className="text-primary" aria-hidden="true"/> Audit ledger</h2><p className="mt-1 text-[10px] text-muted-foreground">Each audit is recorded on this device with the SHA-256 hash of the record before it.</p></div>
        <Button type="button" variant="outline" className="h-8 rounded-none text-[10px] font-bold" disabled={checking} onClick={() => void verify()}>{checking ? "Verifying…" : "Verify ledger"}</Button>
      </div>
      {failure && <p role="alert" className="mt-3 text-[10px] text-coral">{failure}</p>}
      {v && (
        <div role="status" className="mt-3 grid gap-2 text-[10px] leading-relaxed">
          {v.ok ? (
            <p className="flex flex-wrap items-center gap-x-2 text-primary"><ShieldCheck size={13}/> <strong>Ledger intact.</strong> <span className="text-muted-foreground">{v.records} record{v.records === 1 ? "" : "s"} recomputed{v.headHash ? <>; head hash <code className="ledger-mono break-all text-foreground">{v.headHash}</code></> : ""}.</span></p>
          ) : (
            <div className="border border-coral/40 bg-coral/5 p-3 text-coral">
              <p className="flex items-center gap-2 font-bold"><ShieldAlert size={13}/> Ledger broken at record #{v.firstBreak?.index}{v.firstBreak?.runName ? ` (${v.firstBreak.runName})` : ""}.</p>
              <p className="mt-1">{v.firstBreak?.explanation}</p>
              {v.breaks.length > 1 && <ul className="mt-2 list-disc pl-4">{v.breaks.slice(1).map((item, index) => <li key={index}>Record #{item.index}: {item.explanation}</li>)}</ul>}
            </div>
          )}
          {modified.length > 0 && <p className="text-coral"><strong>Differs from its ledger record:</strong> {modified.map((check) => `${check.runName} (record #${check.recordIndex}${v.breaks.some((item) => item.index === check.recordIndex) ? ", which itself fails verification, so neither copy can be trusted" : ", which verifies, so the ledger record is the original"})`).join("; ")}.</p>}
          {unrecorded.length > 0 && <p className="text-review"><strong>Not in the ledger:</strong> {unrecorded.map((check) => check.runName).join(", ")}. Saved before the ledger existed, or recording failed.</p>}
          <p className="text-muted-foreground">The chain detects edits, insertions, removals and reordering of earlier records. On its own it cannot detect removal of the newest records; keep the head hash to compare later.</p>
        </div>
      )}
    </section>
  );
}

function downloadFile(content: BlobPart, type: string, filename: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function ReportExportButtons({ run }: { run: AuditRun }) {
  const [busy, setBusy] = useState<"md" | "pdf" | null>(null);
  const exportReport = async (format: "md" | "pdf") => {
    setBusy(format);
    try {
      const records = await loadLedgerRecords();
      const verification = await verifyLedger(records);
      const record = [...records].reverse().find((item) => item.kind === "audit_recorded" && item.run.id === run.id) ?? null;
      const [runCheck] = await crossCheckRuns(records, [run]);
      const results = runChecks(run);
      let steps: { index: number; label: string; stepId: string | null }[] = [];
      try { steps = parseTrace(runSource(run)).steps.map((step) => ({ index: step.index, label: step.label, stepId: step.stepId })); } catch { steps = []; }
      const report = buildAuditReport({
        run: { id: run.id, name: run.run_name, sourceFilename: run.source_filename, createdAt: run.created_at, eventCount: run.event_count },
        results,
        thresholds: runThresholds(run),
        opinion: auditOpinion(results),
        steps,
        ledger: { record, verification, ...(runCheck ? { runCheck: runCheck.status } : {}) },
        generatedAt: new Date().toISOString(),
      });
      const stem = run.run_name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "audit-report";
      if (format === "md") downloadFile(renderMarkdown(report), "text/markdown;charset=utf-8", `${stem}.md`);
      else downloadFile(renderPdf(report) as BlobPart, "application/pdf", `${stem}.pdf`);
      toast.success(`Report exported as ${format === "md" ? "Markdown" : "PDF"}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The report could not be exported.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <Button variant="outline" className="min-h-10 rounded-none px-4 text-xs font-bold" disabled={busy !== null} onClick={() => void exportReport("md")}><FileText size={15}/> {busy === "md" ? "Exporting…" : "Export Markdown"}</Button>
      <Button variant="outline" className="min-h-10 rounded-none px-4 text-xs font-bold" disabled={busy !== null} onClick={() => void exportReport("pdf")}><FileDown size={15}/> {busy === "pdf" ? "Exporting…" : "Export PDF"}</Button>
    </>
  );
}

export function DashboardPage() {
  const { email, runs, loadingRuns, thresholds, setThresholds, importRun, removeRun, anthropicKey } = useAgentLedger();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fileError, setFileError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "needs-review">("all");
  const [historySort, setHistorySort] = useState<"newest" | "oldest">("newest");
  const latestRun = runs[0] ?? null;
  const sampleRunCount = runs.filter(isGuestDemoAuditRun).length;
  const filteredRuns = useMemo(() => runs.filter((run) =>
    run.run_name.toLowerCase().includes(query.toLowerCase()) &&
    (filter === "all" || runChecks(run).some((check) => check.status !== "pass")),
  ).sort((first, second) => historySort === "newest"
    ? second.created_at.localeCompare(first.created_at)
    : first.created_at.localeCompare(second.created_at),
  ), [filter, historySort, query, runs]);
  const totals = useMemo(() => runs.reduce((value, run) => {
    const checks = runChecks(run);
    value.pass += checks.filter((check) => check.status === "pass").length;
    value.fail += checks.filter((check) => check.status === "fail").length;
    value.unknown += checks.filter((check) => check.status === "not_evidenced").length;
    return value;
  }, { pass: 0, fail: 0, unknown: 0 }), [runs]);

  const readFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setFileError("");
    const isJson = file.name.toLowerCase().endsWith(".json") || file.type.includes("json");
    if (!isJson) { setFileError("Choose a .json log file to begin an audit."); return; }
    if (file.size > 50 * 1024 * 1024) { setFileError("This log exceeds the 50 MB testing limit."); return; }
    if (file.size === 0) { setFileError("This JSON file is empty."); return; }
    setBusy(true);
    try {
      const text = await file.text();
      let source: unknown;
      try { source = JSON.parse(text); } catch { throw new Error("This file is not valid JSON. Correct the file and try again."); }
      const trace = parseTrace(source);
      if (trace.steps.length === 0) throw new Error("This JSON has no run entries to review. Upload an entry or an empty event list with run metadata.");
      const judge = anthropicKey ? createClaudeGroundednessJudge({ apiKey: anthropicKey, browser: true }) : null;
      const checks = await evaluateRun(trace, thresholds, judge);
      const stem = file.name.replace(/\.json$/i, "").replace(/[_-]+/g, " ").trim() || "Agent run";
      const run = await importRun(file.name, source as Json, checks, stem);
      toast.success("Run uploaded. Your linked audit is ready.");
      await navigate({ to: "/findings/$auditId", params: { auditId: run.id } });
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "Could not review this JSON file.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }, [anthropicKey, importRun, navigate, thresholds]);

  const dragEnter = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragging(true); };
  const drop = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragging(false); void readFile(event.dataTransfer.files[0]); };
  const clearHistory = async (run: AuditRun) => {
    if (!window.confirm(`Delete “${run.run_name}” and its original uploaded log? This cannot be undone.`)) return;
    try { await removeRun(run); toast.success("Audit and original log deleted."); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Could not delete the audit."); }
  };

  return (
    <AppFrame active="dashboard">
      <div className="mx-auto max-w-[1240px]">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div><div className="ledger-mono flex items-center gap-2 text-[9px] font-semibold uppercase tracking-[0.18em] text-primary"><span className="size-1.5 bg-primary"/> Control assurance <span className="text-border">/</span>01</div><h1 className="mt-3 font-display text-[27px] font-semibold leading-tight tracking-tight sm:text-[32px]">Run audits<span className="text-primary">.</span></h1><p className="mt-2 max-w-lg text-[12px] leading-relaxed text-muted-foreground sm:text-[13px]">A clear evidence trail for your AI agent runs.</p></div>
          <span className="ledger-mono mt-0.5 inline-flex items-center gap-2 border border-border/80 bg-card/40 px-3 py-2 text-[9px] uppercase tracking-[0.1em] text-muted-foreground">{email ? <LockKeyhole size={11} className="text-signal"/> : <HardDrive size={11} className="text-signal"/>}{email ? "Personal audit space" : "Device-only test space"}</span>
        </div>

        {sampleRunCount > 0 && <div className="mt-5 flex items-start gap-3 border-l-2 border-review/60 bg-review/5 px-3 py-3 sm:px-4"><Sparkles size={14} className="mt-0.5 shrink-0 text-review" aria-hidden="true"/><p className="text-[10px] leading-relaxed text-muted-foreground"><strong className="font-semibold text-foreground">{sampleRunCount} sample audits are ready.</strong> These generated examples cover passing controls, traceability and version gaps, a high hallucination rate, missing oversight, and unmeasured hallucinations. They are marked “SAMPLE” and stay on this device; remove them individually from audit history.</p></div>}

        {(
          <>
            <div className="mt-7 grid grid-cols-2 border-y border-border bg-card/40 sm:grid-cols-4">
              <EvidenceMetric icon={FileJson2} label="Audited runs" value={runs.length.toString().padStart(2,"0")} total={email ? "saved privately" : "saved on this device"}/>
              <EvidenceMetric icon={ShieldCheck} label="Controls passed" value={totals.pass.toString().padStart(2,"0")} total="across your runs"/>
              <EvidenceMetric icon={ShieldAlert} label="Need attention" value={totals.fail.toString().padStart(2,"0")} total="below threshold"/>
              <EvidenceMetric icon={ShieldQuestion} label="Not evidenced" value={totals.unknown.toString().padStart(2,"0")} total="not measured"/>
            </div>

            <div className="mt-6 grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(320px,390px)] xl:gap-8">
              <section className="min-w-0">
                <div className="mb-3 flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-sm font-bold">Upload agent run</h2><p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">Evidence-based review of a JSON trace.</p></div><span className="ledger-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">JSON <span className="text-border">·</span> max 50 MB</span></div>
                <input className="ledger-file-input" ref={fileRef} type="file" accept=".json,application/json" aria-label="Choose a JSON run log" onChange={(event) => void readFile(event.currentTarget.files?.[0])}/>
                <div role="button" tabIndex={0} aria-label="Drop a JSON run log or choose a file" aria-disabled={busy} onClick={() => {if(!busy)fileRef.current?.click();}} onKeyDown={(event) => {if((event.key==="Enter"||event.key===" ")&&!busy){event.preventDefault();fileRef.current?.click();}}} onDragEnter={dragEnter} onDragOver={dragEnter} onDragLeave={(event) => {if(event.currentTarget===event.target)setDragging(false);}} onDrop={drop} className={`ledger-dropzone ${dragging?"ledger-dropzone-active":""} ledger-focusable cursor-pointer border border-dashed px-4 py-9 text-center sm:px-7 sm:py-10 ${busy?"cursor-wait opacity-70":"hover:border-primary/70"}`}>
                  <span className="mx-auto flex size-12 items-center justify-center border border-border bg-card/80 text-primary"><UploadCloud size={20}/></span>
                  <h3 className="mt-4 text-sm font-semibold">{busy?"Reviewing your run…":"Drop a JSON log here"}</h3>
                  <p className="mt-2 text-[11px] text-muted-foreground">or select a file from your device</p>
                  <Button type="button" className="mt-5 min-w-36 rounded-none text-xs font-bold" variant="outline" disabled={busy} onClick={(event) => {event.stopPropagation();fileRef.current?.click();}}>Choose JSON file <ArrowRight size={14}/></Button>
                  <p className="ledger-mono mt-4 flex items-center justify-center gap-1.5 text-[8px] uppercase tracking-[0.09em] text-muted-foreground">{email ? <LockKeyhole size={10}/> : <HardDrive size={10}/>} {email ? "Private to your account" : "Saved only on this device for testing"}</p>
                  {busy && <span className="ledger-grain pointer-events-none absolute inset-x-0 bottom-0 h-1 animate-pulse bg-primary/30"/>}
                </div>
                {fileError && <div role="alert" className="mt-3 flex items-start gap-2 border border-coral/30 bg-coral/5 p-3 text-[11px] leading-relaxed text-coral"><ShieldAlert size={14} className="mt-0.5 shrink-0"/>{fileError}</div>}
                <GroundednessKeyField disabled={busy}/>
                <div className="mt-4 flex gap-3 border border-border/60 bg-card/25 px-4 py-3"><span className="ledger-mono pt-0.5 text-[9px] text-primary">↳</span><p className="text-[10px] leading-relaxed text-muted-foreground">{email ? "Each check is tied to fields found in your log. A hallucination rate is reported only when the file includes an explicit rate or complete per-entry labels." : "Each check is tied to fields found in your log. Test uploads are stored only in this browser and are not sent to cloud storage."}</p></div>
                {latestRun && <div className="mt-6 overflow-hidden border border-border bg-card/50"><div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5"><div><span className="ledger-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">Most recent audit</span><h3 className="mt-1 truncate text-sm font-bold">{latestRun.run_name}</h3></div><Link to="/report/$auditId" params={{auditId:latestRun.id}} className="inline-flex min-h-9 shrink-0 items-center gap-2 border border-border px-3 text-[10px] font-bold hover:border-primary/50 hover:text-primary">View report <ArrowUpRight size={13}/></Link></div><LatestCheckList run={latestRun}/></div>}
                <LedgerVerifier/>
                <div className="mt-8 border-t border-border/80 pt-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-bold">Audit history</h2><p className="mt-1 text-[10px] text-muted-foreground">Your saved runs, newest first.</p></div><div className="flex items-center gap-2"><Button variant={filter==="all"?"secondary":"ghost"} size="sm" className="h-8 text-[10px]" onClick={()=>setFilter("all")}>All runs</Button><Button variant={filter==="needs-review"?"secondary":"ghost"} size="sm" className="h-8 text-[10px]" onClick={()=>setFilter("needs-review")}>Needs review</Button></div></div>
                  <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_190px]"><label className="relative block"><span className="sr-only">Search audit history</span><Input value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="Search runs…" className="h-9 rounded-none border-border/80 bg-background/50 text-[11px]" aria-label="Search audit history"/></label><label className="flex items-center gap-2 text-[9px] text-muted-foreground">Sort: <select aria-label="Sort audit history" value={historySort} onChange={(event)=>setHistorySort(event.target.value as "newest"|"oldest")} className="min-h-9 min-w-0 flex-1 border border-input bg-background px-2 text-[10px] text-foreground"><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select><ChevronDown size={12}/></label></div>
                  <div className="mt-3">
                    {loadingRuns ? <p className="ledger-mono border-y border-border/80 py-6 text-center text-[10px] text-muted-foreground">Loading {email ? "your saved audits" : "device test audits"}…</p> : filteredRuns.length===0 ? <div className="border-y border-border/80 py-6 text-center"><p className="text-[11px] text-muted-foreground">{runs.length===0?"No audit runs yet. Upload a JSON log to get started.":"No runs match these filters."}</p></div> : <div className="ledger-grid-lines grid">{filteredRuns.map((run)=>{const checks=runChecks(run);const fail=checks.filter((check)=>check.status==="fail").length;const unknown=checks.filter((check)=>check.status==="not_evidenced").length;return <div key={run.id} className="flex flex-wrap items-center gap-3 py-3"><div className="flex min-w-0 flex-1 items-center gap-3"><span className={`flex size-8 shrink-0 items-center justify-center border ${fail?"ledger-status-fail":unknown?"ledger-status-unknown":"ledger-status-pass"}`}>{fail?<ShieldAlert size={14}/>:unknown?<ShieldQuestion size={14}/>:<Check size={14}/>}</span><div className="min-w-0"><Link to="/findings/$auditId" params={{auditId:run.id}} className="block truncate text-[11px] font-semibold hover:text-primary">{run.run_name}</Link><span className="ledger-mono mt-1 block truncate text-[9px] text-muted-foreground">{formattedDate(run.created_at,true)} · {run.event_count} {run.event_count===1?"entry":"entries"}</span></div></div><div className="flex items-center gap-2"><span className="ledger-mono text-[9px] text-muted-foreground">{fail?`${fail} fail`:unknown?`${unknown} unevidenced`:`${checks.length} pass`}</span><Link aria-label={`Open ${run.run_name} findings`} to="/findings/$auditId" params={{auditId:run.id}} className="flex size-8 items-center justify-center border border-border/70 text-muted-foreground hover:border-primary/70 hover:text-primary"><ArrowUpRight size={14}/></Link><Button aria-label={`Delete this ${email ? "account" : "device"} audit and its original log`} title={email ? "Delete this audit and its original log" : "Delete this device-only test audit"} size="icon" variant="ghost" className="size-8 text-muted-foreground hover:text-coral" onClick={()=>void clearHistory(run)}><X size={14}/></Button></div></div>;})}</div>}
                  </div>
                </div>
              </section>

              <aside className="border border-border bg-card/45 p-4 sm:p-5">
                <div className="flex items-center justify-between gap-3"><div><span className="ledger-mono text-[9px] uppercase tracking-[0.14em] text-primary">01 <span className="text-border">/</span> Thresholds</span><h2 className="mt-2 text-sm font-bold">Control standards</h2></div><span className="flex size-8 items-center justify-center border border-border bg-secondary/40 text-muted-foreground"><SlidersHorizontal size={14}/></span></div>
                <div className="mt-4 border-y border-border/70 py-2"><ThresholdEditor thresholds={thresholds} onChange={setThresholds}/></div>
                {!email && <p className="mt-3 flex items-start gap-2 text-[10px] leading-relaxed text-review"><HardDrive size={12} className="mt-0.5 shrink-0"/> Testing without sign-in. Audits stay in this browser and are not uploaded to account storage.</p>}
                <div className="mt-5 border-t border-border/70 pt-4"><h3 className="flex items-center gap-2 text-[11px] font-semibold"><ShieldCheck size={14} className="text-primary"/> How evidence is checked</h3><div className="mt-3 grid gap-3 text-[10px] leading-relaxed text-muted-foreground"><p><span className="font-semibold text-foreground/80">Traceability</span> — a stable ID or timestamp identifies the entry.</p><p><span className="font-semibold text-foreground/80">Versioning</span> — model or agent version is recorded in the entry.</p><p><span className="font-semibold text-foreground/80">Hallucinations</span> — an explicit rate or complete set of entry-level labels is present.</p><p><span className="font-semibold text-foreground/80">Oversight</span> — review, reviewer, or approval fields are recorded.</p><p><span className="font-semibold text-foreground/80">Groundedness</span> — with your API key, Claude extracts each answer's factual claims and checks them against tool outputs earlier in the trace.</p></div><div className="mt-4 border-l-2 border-review/50 bg-review/5 py-2 pl-3 pr-2"><p className="flex items-center gap-1.5 text-[9px] font-semibold text-review"><ShieldQuestion size={11}/> Missing evidence is never a pass.</p><p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">These checks support internal review; they are not independent verification or a compliance certification.</p></div></div>
              </aside>
            </div>
            {latestRun && <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-4 text-[9px] text-muted-foreground"><span className="ledger-mono uppercase tracking-[0.07em]">Latest source <span className="text-border">/</span> {latestRun.source_filename}</span><Link to="/findings/$auditId" params={{auditId:latestRun.id}} className="inline-flex items-center gap-1.5 hover:text-primary">Review the entry index <ArrowRight size={12}/></Link></div>}
          </>
        )}
      </div>
    </AppFrame>
  );
}

function exactEntryIndex(eventPath: string, events: TraceStep[]): number | null {
  let longest = -1;
  let match: number | null = null;
  events.forEach((event, index) => {
    if (event.path.length > longest && (eventPath === event.path || eventPath.startsWith(`${event.path}.`))) {
      longest = event.path.length;
      match = index;
    }
  });
  return match;
}

export function FindingsPage({ auditId }: { auditId: string }) {
  const { runs, loadingRuns, email } = useAgentLedger();
  const run = runs.find((item) => item.id === auditId);
  const events = useMemo(() => run ? parseTrace(runSource(run)).steps : [], [run]);
  const checks = run ? runChecks(run) : [];

  if (!run && loadingRuns) return <AppFrame active="findings"><div className="ledger-mono py-14 text-center text-xs text-muted-foreground">Loading {email ? "your private audit" : "device test audit"}…</div></AppFrame>;
  if (!run) return <AppFrame active="findings"><div className="mx-auto max-w-xl border border-border bg-card p-6 text-center sm:p-10"><LockKeyhole size={19} className="mx-auto text-review"/><h1 className="mt-4 text-lg font-bold">{email?"Audit not found":"Device test audit not found"}</h1><p className="mt-2 text-xs leading-relaxed text-muted-foreground">{email?"This audit may have been removed or belongs to another account. Private run records are never shared between users.":"This test audit is available only in the browser where it was created. Upload the JSON again to review it here."}</p><Link className="mt-5 inline-flex items-center gap-2 text-xs font-semibold text-primary hover:text-foreground" to="/">Return to dashboard <ArrowLeft size={14}/></Link></div></AppFrame>;

  return (
    <AppFrame active="findings">
      <div className="mx-auto max-w-[1120px]">
        <Link to="/" className="ledger-focusable mb-5 inline-flex items-center gap-2 text-[10px] font-semibold text-muted-foreground hover:text-primary"><ArrowLeft size={13}/> Back to dashboard</Link>
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border/80 pb-5">
          <div className="min-w-0"><div className="ledger-mono flex items-center gap-2 text-[9px] uppercase tracking-[0.15em] text-primary"><CircleDot size={11}/> Linked findings <span className="text-border">/</span>{run.source_filename}</div><h1 className="mt-3 truncate text-[23px] font-semibold tracking-tight sm:text-[27px]">{run.run_name}<span className="text-primary">.</span></h1><p className="ledger-mono mt-2 text-[9px] text-muted-foreground">AUDIT {run.id.slice(0,8).toUpperCase()} <span className="mx-1 text-border">/</span>{formattedDate(run.created_at)} <span className="mx-1 text-border">/</span>{events.length} {events.length===1?"entry":"entries"}</p></div>
          <Link to="/report/$auditId" params={{auditId:run.id}} className="flex min-h-9 items-center gap-2 border border-border px-3 text-[10px] font-bold hover:border-primary/70 hover:text-primary"><FileDown size={14}/> Printable report <ArrowUpRight size={12}/></Link>
        </div>
        <div className="mt-5 border border-border bg-card/45 px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex items-center gap-3"><span className={`flex size-9 items-center justify-center border ${checks.some((check)=>check.status==="fail")?"ledger-status-fail":checks.some((check)=>check.status==="not_evidenced")?"ledger-status-unknown":"ledger-status-pass"}`}>{checks.some((check)=>check.status==="fail")?<ShieldAlert size={16}/>:checks.some((check)=>check.status==="not_evidenced")?<ShieldQuestion size={16}/>:<ShieldCheck size={16}/>}</span><div><span className="ledger-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">Overall opinion</span><h2 className="mt-1 text-sm font-bold leading-snug">{auditOpinion(checks).title}</h2></div></div><span className="ledger-mono text-[9px] text-muted-foreground">{checks.filter((check)=>check.status==="pass").length}/{checks.length} PASS</span></div>
          <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">{auditOpinion(checks).explanation}</p>
        </div>
        <div className="mt-8 flex flex-wrap items-end justify-between gap-3"><div><span className="ledger-mono text-[9px] uppercase tracking-[0.14em] text-primary">01 <span className="text-border">/</span> Results</span><h2 className="mt-2 text-sm font-bold">Control checklist</h2></div><p className="text-right text-[9px] leading-relaxed text-muted-foreground">Original thresholds are preserved<br/>with this audit.</p></div>
        <div className="mt-3 grid gap-2" onClick={(event) => {
          const target = event.target;
          if (!(target instanceof Element)) return;
          const link = target.closest<HTMLAnchorElement>('a[href^="#source-entry-"]');
          const entryId = link?.hash.slice(1);
          const source = entryId ? document.getElementById(entryId) : null;
          if (source instanceof HTMLDetailsElement) source.open = true;
        }}>
          {checks.map((check,index)=>{
            const Icon=iconsByControl[check.id];
            const uniquePaths=[...new Set(measuredPaths(check))];
            const anchors=[...new Set(uniquePaths.map((path)=>exactEntryIndex(path,events)).filter((index):index is number=>index!==null))];
            const isUnknown = check.status==="not_evidenced";
            return <section key={check.id} className="border border-border/80 bg-card/40"><div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 px-3 py-3 sm:px-4"><div className="flex min-w-0 items-center gap-3"><span className="ledger-mono text-[9px] text-muted-foreground">0{index+1}</span><span className="flex size-8 shrink-0 items-center justify-center border border-border bg-secondary/40 text-muted-foreground"><Icon size={15}/></span><div className="min-w-0"><h3 className="truncate text-[11px] font-bold">{check.name}</h3><p className="mt-0.5 truncate text-[9px] text-muted-foreground">{check.summary}</p></div></div><StatusPill status={check.status}/></div><div className="flex flex-wrap items-center justify-between gap-3 px-3 py-3 sm:px-4"><div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5"><span className="ledger-mono text-[9px] text-muted-foreground">Observed <strong className="ml-1 font-semibold text-foreground">{formatPercent(check.measured)}</strong></span><span className="ledger-mono text-[9px] text-muted-foreground">Threshold <strong className="ml-1 font-semibold text-foreground">{check.direction==="minimum"?"≥":"≤"} {check.threshold}%</strong></span><span className="text-[9px] text-muted-foreground">{check.message}</span></div><div className="flex shrink-0 flex-wrap gap-2">{anchors.length>0?anchors.slice(0,2).map((entryIndex)=> <a key={entryIndex} href={`#source-entry-${entryIndex}`} className="inline-flex min-h-7 items-center gap-1.5 border border-primary/25 bg-accent/40 px-2 text-[9px] font-semibold text-primary hover:bg-accent">{events[entryIndex]?.label??`Entry ${entryIndex+1}`} <ArrowDown size={10}/></a>):isUnknown?<span className="flex min-h-7 items-center gap-1.5 border border-review/25 px-2 text-[9px] text-review"><ShieldQuestion size={10}/> No supporting entry</span>:<span className="flex min-h-7 items-center gap-1.5 border border-border px-2 text-[9px] text-muted-foreground">No matching fields</span>}{anchors.length>2&&<span className="self-center text-[9px] text-muted-foreground">+{anchors.length-2} more</span>}</div></div><JudgedDetails check={check}/></section>;
          })}
        </div>
        <div className="mt-9 border-t border-border/80 pt-5"><div className="flex flex-wrap items-end justify-between gap-3"><div><span className="ledger-mono text-[9px] uppercase tracking-[0.14em] text-primary">02 <span className="text-border">/</span> Evidence</span><h2 className="mt-2 text-sm font-bold">Original log entries</h2></div><span className="ledger-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground">{events.length} source {events.length===1?"entry":"entries"}</span></div><p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">Linked findings jump directly to the exact entry and source field. {email ? "The original uploaded JSON is retained privately." : "The test JSON stays in this browser and is not uploaded to cloud storage."}</p></div>
        {events.length===0?<div className="mt-4 border border-border px-4 py-5 text-xs text-muted-foreground">No original entries were found in this run.</div>:<div className="ledger-grid-lines mt-4 grid border-y border-border/80" id="evidence">{events.map((event,index)=>{const evidenceForEntry=checks.filter((check)=>measuredPaths(check).some((path)=>path===event.path||path.startsWith(`${event.path}.`)));return <details key={index} id={`source-entry-${index}`} className="scroll-mt-20 group py-1 marker:content-none open:pb-3"><summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 py-2 hover:text-primary [&::-webkit-details-marker]:hidden"><span className="ledger-mono min-w-[40px] text-[9px] text-muted-foreground">{`E-${String(index+1).padStart(3,"0")}`}</span><span className="flex size-6 shrink-0 items-center justify-center border border-border/70 bg-secondary/30 text-muted-foreground group-open:text-primary"><ChevronDown size={12} className="transition-transform group-open:rotate-180"/></span><span className="min-w-0 flex-1 truncate text-[10px] font-semibold">{event.label}</span><span className="hidden min-w-0 max-w-[40%] truncate text-right text-[9px] text-muted-foreground sm:block">{formatTracePath(event.path)}</span>{evidenceForEntry.map((check)=><span key={check.id} className="hidden sm:inline-block"><StatusPill status={check.status}/></span>)}</summary><div className="ml-[52px] grid min-w-0 gap-2 pb-3"><div className="border-l border-primary/45 bg-background/55 p-3 sm:p-4"><div className="ledger-mono mb-2 flex flex-wrap justify-between gap-2 text-[9px] text-muted-foreground"><span>EXACT SOURCE <span className="text-border">/</span> {event.path}</span><span>{evidenceForEntry.map((check)=>check.name).join(" · ")||"No control fields matched"}</span></div><pre className="ledger-mono max-h-[460px] overflow-auto whitespace-pre-wrap break-words text-[9px] leading-relaxed text-foreground/90 sm:text-[10px]">{JSON.stringify(event.value,null,2)}</pre></div>{evidenceForEntry.flatMap((check)=>measuredPaths(check).filter((path)=>path===event.path||path.startsWith(`${event.path}.`)).map((path)=> <div key={`${check.id}-${path}`} className="flex flex-wrap items-center gap-2 text-[9px]"><span className="text-primary">{check.name}</span><span className="text-muted-foreground">← {formatTracePath(path)}</span></div>))}</div></details>;})}</div>}
        <div className="mt-5 border-l-2 border-review/50 bg-review/5 p-3 sm:p-4"><div className="flex items-center gap-2 text-[10px] font-semibold text-review"><ShieldQuestion size={13}/> Important: Evidence is not certification.</div><p className="mt-1.5 max-w-4xl text-[10px] leading-relaxed text-muted-foreground">Results describe only the JSON provided and the selected thresholds. A missing hallucination label is reported as “Not evidenced”—not assumed to be zero. Human review is credited only when review or approval is explicitly recorded.</p></div>
      </div>
    </AppFrame>
  );
}

export function ReportPage({ auditId }: { auditId: string }) {
  const { runs, loadingRuns, email } = useAgentLedger();
  const run = runs.find((item)=>item.id===auditId);
  const checks=run?runChecks(run):[];
  if(!run&&loadingRuns)return <AppFrame active="report"><p className="ledger-mono py-10 text-center text-xs text-muted-foreground">Preparing your report…</p></AppFrame>;
  if(!run)return <AppFrame active="report"><div className="mx-auto max-w-lg border border-border bg-card p-8 text-center"><LockKeyhole className="mx-auto text-review"/><h1 className="mt-4 text-lg font-bold">{email?"Report not found":"Device test report not found"}</h1><p className="mt-2 text-xs leading-relaxed text-muted-foreground">{email?"Private audit reports can be viewed only by their owner.":"This test report is available only in the browser where it was created."}</p><Link to="/" className="mt-5 inline-flex items-center gap-2 text-xs font-semibold text-primary"><ArrowLeft size={14}/> Dashboard</Link></div></AppFrame>;
  const opinion=auditOpinion(checks);
  const thresholds=runThresholds(run);
  const generated=formattedDate(run.created_at);
  return <AppFrame active="report"><div className="ledger-screen mx-auto max-w-[960px]">
    <Link to="/findings/$auditId" params={{auditId:run.id}} className="inline-flex items-center gap-2 text-[10px] font-semibold text-muted-foreground hover:text-primary"><ArrowLeft size={13}/> Back to findings</Link>
    <div className="mt-5 flex flex-wrap items-end justify-between gap-4 border-b border-border/80 pb-4"><div><span className="ledger-mono text-[9px] uppercase tracking-[0.14em] text-primary">AgentLedger <span className="text-border">/</span> Audit report</span><h1 className="mt-2 text-[23px] font-semibold tracking-tight">Audit opinion<span className="text-primary">.</span></h1></div><div className="flex flex-wrap gap-2"><ReportExportButtons run={run}/><Button className="min-h-10 rounded-none px-4 text-xs font-bold" onClick={()=>window.print()}><Printer size={15}/> Print</Button></div></div>
    <p className="mt-2 text-[10px] text-muted-foreground">Exports are built on this device from the stored audit and its ledger record, including cited evidence, method and limitations. Print opens your browser’s print window for this page.</p>
  </div>
  <div className="ledger-report mx-auto max-w-[820px] bg-background text-foreground">
    <header className="flex items-start justify-between gap-4 border-b-2 border-foreground/80 pb-7">
      <div><div className="flex items-center gap-2 text-primary"><ShieldCheck size={18}/><span className="ledger-mono text-[10px] font-semibold uppercase tracking-[0.2em]">AgentLedger / Run assurance</span></div><h1 className="mt-8 text-4xl font-bold tracking-tight">AI agent run<br/>audit report<span className="text-primary">.</span></h1><p className="mt-4 max-w-md text-sm text-muted-foreground">Evidence-linked control review based solely on the supplied JSON log.</p></div>
      <span className="ledger-mono ledger-print-inline-flex border border-border px-3 py-2 text-center text-[10px] uppercase tracking-[0.14em]">{isGuestAuditRun(run) ? <>LOCAL TEST<br/><span className="ledger-print-inline text-primary">DEVICE ONLY</span></> : <>PRIVATE<br/><span className="ledger-print-inline text-primary">OWNER ONLY</span></>}</span>
    </header>
    <section className="ledger-print-grid grid grid-cols-2 gap-x-5 gap-y-5 border-b border-border py-7 sm:grid-cols-4"><div className="col-span-2 min-w-0"><span className="ledger-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">Agent run</span><p className="mt-2 break-words text-lg font-bold">{run.run_name}</p></div><div><span className="ledger-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">Source file</span><p className="mt-2 break-words text-xs">{run.source_filename}</p></div><div><span className="ledger-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">Entries reviewed</span><p className="ledger-mono mt-2 text-sm">{run.event_count.toString().padStart(2,"0")}</p></div><div><span className="ledger-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">Audit ID</span><p className="ledger-mono mt-2 break-all text-[10px]">{run.id}</p></div><div><span className="ledger-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">Report generated</span><p className="mt-2 text-xs">{generated}</p></div><div><span className="ledger-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">Overall opinion</span><p className="mt-2 text-xs font-bold">{opinion.title}</p></div></section>
    <aside className="my-7 border-l-[3px] border-primary bg-secondary/55 px-5 py-5"><span className="ledger-mono text-[9px] uppercase tracking-[0.15em] text-primary">01 <span className="text-border">/</span> Audit opinion</span><h2 className="mt-3 text-lg font-bold">{opinion.title}</h2><p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted-foreground">{opinion.explanation}</p></aside>
    <section className="mt-8"><div className="flex flex-wrap items-end justify-between gap-3"><div><span className="ledger-mono text-[9px] uppercase tracking-[0.15em] text-primary">02 <span className="text-border">/</span> Evaluation</span><h2 className="mt-2 text-base font-bold">Control checklist</h2></div><span className="ledger-mono text-[9px] text-muted-foreground">Observed evidence <span className="text-border">/</span> Selected thresholds</span></div><div className="mt-4 border-y border-border"><div className="ledger-print-grid grid grid-cols-[minmax(0,1fr)_78px_88px_110px] gap-2 border-b border-border bg-secondary/55 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_96px_110px_125px] sm:gap-3 sm:px-4"><span className="ledger-mono text-[8px] uppercase tracking-[0.1em] text-muted-foreground">Control / method</span><span className="ledger-mono text-right text-[8px] uppercase text-muted-foreground">Observed</span><span className="ledger-mono text-right text-[8px] uppercase text-muted-foreground">Threshold</span><span className="ledger-mono text-right text-[8px] uppercase text-muted-foreground">Outcome</span></div>{checks.map((check)=>{const Icon=iconsByControl[check.id];return <div key={check.id} className="ledger-print-grid grid grid-cols-[minmax(0,1fr)_78px_88px_110px] items-center gap-2 border-b border-border/70 px-3 py-3 last:border-0 sm:grid-cols-[minmax(0,1fr)_96px_110px_125px] sm:gap-3 sm:px-4"><div className="flex min-w-0 items-center gap-2"><Icon size={13} className="shrink-0 text-muted-foreground"/><span className="min-w-0 text-[10px] font-semibold leading-snug">{check.name}</span></div><span className="ledger-mono text-right text-[9px] tabular-nums">{formatPercent(check.measured)}</span><span className="ledger-mono text-right text-[9px] tabular-nums">{check.direction==="minimum"?"≥":"≤"} {check.threshold}%</span><span className="flex justify-end"><StatusPill status={check.status}/></span><p className="col-span-full pl-5 text-[8px] leading-relaxed text-muted-foreground sm:pl-[22px]">{check.summary}</p>{check.method&&<p className="col-span-full pl-5 text-[8px] leading-relaxed text-muted-foreground sm:pl-[22px]"><MethodLine method={check.method}/></p>}</div>;})}</div></section>
    <div className="ledger-print-grid mt-8 grid gap-7 sm:grid-cols-2"><div><span className="ledger-mono text-[9px] uppercase tracking-[0.12em] text-primary">03 <span className="text-border">/</span> Thresholds applied</span><div className="mt-3 grid gap-2 text-[10px] text-muted-foreground"><p>Traceability ≥ <strong className="text-foreground">{thresholds.traceabilityMin}%</strong></p><p>Versioning ≥ <strong className="text-foreground">{thresholds.versioningMin}%</strong></p><p>Hallucination rate ≤ <strong className="text-foreground">{thresholds.hallucinationMax}%</strong></p><p>Human oversight ≥ <strong className="text-foreground">{thresholds.oversightMin}%</strong></p>{checks.some((check)=>check.id==="groundedness")&&<p>Groundedness ≥ <strong className="text-foreground">{thresholds.groundednessMin}%</strong></p>}</div></div><div><span className="ledger-mono text-[9px] uppercase tracking-[0.12em] text-primary">04 <span className="text-border">/</span> Review method</span><ul className="mt-3 grid list-disc gap-2 pl-4 text-[9px] leading-relaxed text-muted-foreground marker:text-primary"><li>Traceability: fraction of entries containing a stable ID or timestamp.</li><li>Versioning: fraction containing a model or agent version.</li><li>Hallucination rate: only explicit per-entry labels or log-provided rates count as measurements.</li><li>Human oversight: fraction with explicit review or approval fields; recorded intent is not proof of a completed review.</li><li>Every entry and source field can be inspected in the linked findings page.</li></ul></div></div>
    <aside className="my-8 border border-review/40 bg-review/5 p-4"><h2 className="flex items-center gap-2 text-xs font-bold text-review"><ShieldQuestion size={15}/> Limitations and interpretation</h2><p className="mt-2 text-[9px] leading-relaxed text-muted-foreground">This report is an internal evidence summary, not a security assessment, factual truth guarantee, independent verification, legal opinion, or formal compliance certification. The sample is limited to the JSON entries supplied. Fields can be incomplete, mislabeled or inaccurate. “Not evidenced” means the source did not provide a usable measurement; it does not mean the control passed or failed in reality.</p></aside>
    <footer className="mt-10 border-t-2 border-foreground/70 pt-4"><div className="ledger-print-grid grid grid-cols-2 items-end gap-4"><div><span className="ledger-mono text-[9px] font-semibold uppercase tracking-[0.15em]">AgentLedger</span><p className="mt-1 text-[8px] text-muted-foreground">Evidence, not assumptions.</p></div><div className="ledger-mono text-right text-[8px] uppercase tracking-[0.1em] text-muted-foreground">Generated {generated}<br/>Report {run.id.slice(0,8).toUpperCase()}</div></div></footer>
  </div></AppFrame>;
}