# AgentLedger implementation plan

## User experience
- Replace the blank home screen with a dark, minimal, account-protected agent-run audit workspace.
- Let users upload JSON run logs, calculate four transparent evidence-based checks, adjust thresholds, and persist each audit and its original log privately.
- Provide linked findings that open the exact source entry and a clean, printable audit report with a qualified overall opinion.
- Add email/password plus Lovable-managed Google and Lovable sign-in so private audits belong to individual users.

## Technical approach
- Use a private Cloud Storage bucket for original JSON files and a `public.audit_runs` table for per-user audit details, check results, thresholds, and indexed source entries.
- Apply authenticated-only access to each user's database records and only that user's files; grant the table API permissions before enabling row security.
- Keep parsing and scoring in small pure helpers, explain what counts as evidenced, and treat an unavailable hallucination measurement as “Not evidenced.”
- Use the existing TanStack Start routes, components, semantic design tokens, and the project's established Supabase client. Add concrete tests for threshold behavior and evidence classification.

## Out of scope
- No external model calls, automatic claims of legal/compliance certification, team sharing, or administrator role system.
