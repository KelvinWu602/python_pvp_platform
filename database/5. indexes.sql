-- 5. indexes.sql
-- Performance indexes for the app schema.
--
-- After the denormalization pass (see 4. triggers.sql), the hot user paths no
-- longer need LATERAL / EXISTS on app.battle. This changes which indexes
-- matter:
--
-- KEPT:
-- - idx_snapshot_code_id_created_at: GET /code/:cid/snapshot orders by
--     created_at_utc DESC. Also used by the migration's backfill query.
-- - idx_execution_log_battle_id: admin / debug queries that look up all
--     Lambda attempts for a given battle.
--
-- ADDED:
-- - idx_code_user_competition_updated_at: powers GET /enroll/:eid/code —
--     "list codes I authored for this competition, newest first" — as a
--     plain index scan on app.code (no join into app.snapshot).
-- - idx_snapshot_success_by_code: partial index over snapshots whose latest
--     test succeeded, keyed by code_id. Used by the matchmaking queries in
--     POST /enroll/:eid/battle to find eligible opponent snapshots quickly.
-- - idx_enroll_competition_selected_code: covers the random-opponent scan
--     in POST /enroll/:eid/battle (competition-scoped enrollments with a
--     selected code).
--
-- DROPPED (obsolete after denormalization):
-- - idx_battle_a_snapshot_id, idx_battle_b_snapshot_id: the "does this
--     snapshot have any successful battle?" EXISTS queries are gone — the
--     answer is now app.snapshot.latest_test_status = 'success' on the row
--     itself.
-- - idx_code_select_enroll_id: table app.code_select no longer exists.

CREATE INDEX IF NOT EXISTS idx_snapshot_code_id_created_at
    ON app.snapshot (code_id, created_at_utc DESC);

CREATE INDEX IF NOT EXISTS idx_execution_log_battle_id
    ON app.execution_log (battle_id);

CREATE INDEX IF NOT EXISTS idx_code_user_competition_updated_at
    ON app.code (user_id, competition_id, updated_at_utc DESC);

CREATE INDEX IF NOT EXISTS idx_snapshot_success_by_code
    ON app.snapshot (code_id)
    WHERE latest_test_status = 'success';

CREATE INDEX IF NOT EXISTS idx_enroll_competition_selected_code
    ON app.enroll (competition_id, selected_code_id);
