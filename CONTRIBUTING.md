# Contributing

Thanks for helping. Please keep changes small and evidence-based.

## Setup

```sh
bun install --frozen-lockfile
bun run dev
```

Before opening a pull request, run all four checks. CI runs the first three, and the Pages workflow runs the tests:

```sh
bun run lint && bun run typecheck && bun run test && bun run build
```

## Rules

1. **Never invent data or metrics.** Every number must be computed from an uploaded log or from user input. Unmeasured means `not_evidenced`, never a pass or a zero. Do not add benchmark or accuracy claims to docs or the README unless a committed eval report backs them.
2. **Label every sample `SAMPLE`.** Fixtures, demo data, eval traces and screenshots must be visibly marked as synthetic and must never be stored as if they were real audits.
3. **No secrets in git, storage or logs.** The user's Anthropic key lives in memory only. Never persist it, log it, or put it in an error message.
4. **Write the test first.** Scoring logic belongs in `src/lib/audit` (pure, no UI imports). A new control needs tests for pass, fail and missing data.
5. **Make small commits with clear messages,** using an imperative subject line such as "Add oversight threshold validation".

## Project-specific notes

- If you change the groundedness prompt or schema, bump `GROUNDEDNESS_PROMPT_VERSION` and re-run `bun run eval:groundedness`.
- If you change scoring, the ledger record format or hashing, bump `AUDIT_ENGINE_VERSION`.
- This repository syncs with Lovable. Do not hand-edit generated files (`src/integrations/`, `src/routeTree.gen.ts`), `drizzle/` or `supabase/`, and never rewrite pushed history. See [AGENTS.md](AGENTS.md).
- Project conventions for AI coding assistants are in [CLAUDE.md](CLAUDE.md).

## Reporting issues

Open a GitHub issue with the steps to reproduce. If a trace is involved, attach a minimal **synthetic** one; never attach real customer or production data.
