CREATE TABLE public.audit_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  run_name text NOT NULL,
  source_filename text NOT NULL,
  storage_path text NOT NULL,
  source_log jsonb NOT NULL,
  checks jsonb NOT NULL,
  thresholds jsonb NOT NULL,
  opinion text NOT NULL,
  event_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.audit_runs TO authenticated;
GRANT ALL ON public.audit_runs TO service_role;
ALTER TABLE public.audit_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own audit runs" ON public.audit_runs
  FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE INDEX audit_runs_user_created_idx ON public.audit_runs (user_id, created_at DESC);
CREATE POLICY "Users read their own AgentLedger JSON logs" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'agentledger-run-logs'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );
CREATE POLICY "Users upload their own AgentLedger JSON logs" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'agentledger-run-logs'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );
CREATE POLICY "Users update their own AgentLedger JSON logs" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'agentledger-run-logs'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  )
  WITH CHECK (
    bucket_id = 'agentledger-run-logs'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );
CREATE POLICY "Users delete their own AgentLedger JSON logs" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'agentledger-run-logs'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );