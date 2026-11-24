# CLAUDE.md

AgentLedger audits AI-agent runs. A user uploads a JSON log of an agent run. The app scores four controls (traceability, versioning, hallucination rate, human oversight) as pass, fail or not evidenced against thresholds the user can edit. It then shows findings that link to the exact log entries, plus a printable audit report with an overall opinion.

This project is synced with Lovable. **Read `AGENTS.md` first.** Its Lovable block (no force-pushes or history rewrites, no hand edits to `drizzle/` or `supabase/migrations/`, generated files, or secrets) overrides anything below.

## Stack

- **Framework:** TanStack Start (React 19 SSR) with TanStack Router file-based routing, built with Vite 8 through `@lovable.dev/vite-tanstack-config`. Nitro is the server build and Cloudflare is the default target.
- **Language:** TypeScript in strict mode (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). The `@/*` path alias points to `src/*`.
- **UI:** Tailwind CSS v4, shadcn/ui (Radix) components, lucide-react icons and sonner toasts.
- **Data:** Supabase (auth, Postgres, private storage) through Lovable Cloud. The Drizzle schema and migrations live in `drizzle/`. Guest/test audits are kept in browser IndexedDB only.
- **Tests:** Vitest with jsdom and Testing Library.
- **Lint/format:** ESLint 9 (typescript-eslint, react-hooks, react-refresh) runs Prettier as a lint rule.
- **Package manager:** Bun. `bun.lock` is the lockfile, and `bunfig.toml` enforces a 24h minimum release age. Don't add exclusions without asking the user.

## Folder map

```
src/
  routes/                  File-based routes (see src/routes/README.md)
    __root.tsx             App shell; wraps every page in LedgerProvider
    index.tsx              /                   → DashboardPage
    findings.$auditId.tsx  /findings/:auditId  → FindingsPage
    report.$auditId.tsx    /report/:auditId    → ReportPage
  components/
    agent-ledger/ledger-app.tsx   Dashboard, findings and report UI
    ui/                    shadcn/ui primitives (generated; avoid hand edits)
  lib/
    audit/                 Pure audit engine; no UI/framework/storage imports (enforced by a test)
      trace.ts             Trace schema types + parseTrace (see docs/trace-schema.md)
      controls.ts          Declarative control rules (id, description, NIST AI RMF mapping, check)
      evaluate.ts          evaluateTrace, auditOpinion, readStoredResults
      fixtures.ts          Six SAMPLE run fixtures with expected outcomes
      groundedness.ts      Groundedness control: answer/tool-output pairing, versioned judge prompt, scoring
      agreement.ts         Precision/recall/kappa vs hand labels; labels.csv parser
      ledger.ts            Hash-chained audit ledger: canonical JSON, WebCrypto SHA-256, verify, cross-check
    report/                Report export: one model (audit-report.ts) → markdown.ts and pdf.ts (no deps, no network)
    judge/claude-groundedness-judge.ts  Claude judge (user's own API key, in memory only)
    agent-ledger-local.ts  Guest mode: IndexedDB storage, device thresholds, SAMPLE demo audits
    agent-ledger-context.tsx  LedgerProvider / useAgentLedger shared audit state
    error-*.ts, lovable-error-reporting.ts  Error capture and error page
  integrations/
    supabase/              Supabase clients, auth middleware, DB types (GENERATED, do not edit)
    lovable/               Lovable auth integration (GENERATED, do not edit)
  test/                    Vitest suites and setup (test/audit/ covers the engine)
  routeTree.gen.ts         Generated route tree (do not edit)
  router.tsx, start.ts, server.ts   Router, Start entry, SSR error wrapper
docs/trace-schema.md       Upload format and control/status rules
docs/ledger.md             Ledger record format, verification and limitations
evals/groundedness/        34 SAMPLE traces + labels.csv for the groundedness eval (see its README)
scripts/eval-groundedness.ts  Runs the groundedness eval and writes a report
drizzle/                   DB schema and migrations (Lovable-managed, do not edit)
supabase/config.toml       Supabase project config
.lovable/                  Lovable project metadata and plans
public/                    Static assets
roadmap.md                 Task roadmap
```

## Commands

```sh
bun install --frozen-lockfile   # install dependencies
bun run dev                     # start the dev server (vite dev)
bun run test                    # run tests once (vitest run)
bun run test:watch              # run tests in watch mode
bun run lint                    # eslint (includes the prettier/prettier rule)
bun run typecheck               # tsc --noEmit
bun run build                   # production build → .output/
bun run preview                 # preview the production build
bun run format                  # prettier --write . (reformats files; check the diff)
ANTHROPIC_API_KEY=… bun run eval:groundedness   # groundedness eval; calls Claude, billed to that key
```

CI (`.github/workflows/ci.yml`) runs lint, typecheck and build on every push and pull request.

## Rules

1. **Never invent data or metrics.** Every number shown to users must be computed from an uploaded log or from data the user entered. Never fabricate pass rates, counts, benchmarks or results in code, docs, commit messages or reports. If something wasn't measured, show "not evidenced"; don't guess, and don't treat it as a pass or a zero. Keep control checks pure, transparent and deterministic, and a check with missing data must return `not_evidenced`, never `pass`.
2. **Every sample is labelled SAMPLE.** All demo or sample data, including seeded audits, fixtures shown in the UI, and example logs, must carry a visible `SAMPLE` label (see `SAMPLE_RUNS` in `src/lib/audit/fixtures.ts`). Sample data must stay distinguishable from real audits and must never be written to owner-scoped cloud tables or storage.
3. **No secrets in git, storage or logs.** The user's Anthropic API key for the groundedness judge lives only in React state (`anthropicKey` in the ledger context) and is sent only to api.anthropic.com. Never persist it (localStorage, IndexedDB, Supabase), log it, or put it in error messages. The eval script reads it from `ANTHROPIC_API_KEY` and never writes it out. Never commit service-role keys, `sb_secret_*` keys, `LOVABLE_API_KEY`, database URLs or tokens. Lovable manages secrets. Only the public Supabase URL, project ID and publishable key are allowed in client code or `.env`. Keep server-only values out of browser code (`*.server.ts`).
4. **Write tests before features.** Add a failing test in `src/test/` first, then implement until it passes. Scoring logic belongs in `src/lib/audit` (pure, no UI imports); add a control by adding a rule to `CONTROLS` plus tests for pass, fail and missing data.
5. **Small commits with clear messages.** Make one logical change per commit, with an imperative subject line (e.g. "Add oversight threshold validation"). Commits to `main` sync to Lovable, so keep the branch working: run lint, typecheck, test and build before pushing. Never rewrite pushed history.

## Gotchas

- Don't add plugins to `vite.config.ts` that the Lovable config already includes (React, Tailwind, tsconfig paths, Nitro and others; see the file header). Never set `ssr.external` or `resolve.external`.
- Use `*.server.ts` or `@tanstack/react-start/server-only` for server-only modules, not the Next.js `server-only` package (ESLint enforces this).
- At the time of writing, `bun run lint` reports Prettier formatting errors across existing files, including generated Supabase files. Every error is formatting only (`prettier/prettier`). There are no other rule violations.
