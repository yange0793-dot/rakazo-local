-- Evaluate the authenticated system bypass once per statement, as other policies do.
-- An omitted WITH CHECK reuses USING for writes.
DO $$
DECLARE
  protected TEXT;
BEGIN
  FOREACH protected IN ARRAY ARRAY[
    'semantic_facts',
    'semantic_fact_revisions',
    'semantic_fact_sources',
    'semantic_memory_retirements',
    'semantic_memory_index_outbox',
    'model_catalog_sources',
    'memory_archive_progress',
    'lesson_usage',
    'taught_skill_revisions',
    'run_taught_skill_revisions'
  ] LOOP
    EXECUTE format('DROP POLICY %I ON %I', protected || '_system', protected);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ((SELECT app_rls_bypass()))',
      protected || '_system', protected
    );
  END LOOP;
END $$;
