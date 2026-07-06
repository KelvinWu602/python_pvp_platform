-- 5. indexes.sql
-- Performance indexes for the app schema.
--
-- Why these exist:
-- 1. idx_snapshot_code_id_created_at: Every GET /code endpoint needs "latest
--    snapshot per code_id". Without this index, PostgreSQL seq-scans all
--    snapshots and sorts by created_at_utc for every request.
--
-- 2. idx_battle_a_snapshot_id / idx_battle_b_snapshot_id (partial): The
--    "tested" check queries EXIST(SELECT 1 FROM app.battle WHERE
--    (a_snapshot_id=$1 OR b_snapshot_id=$1) AND infra_ok=true AND
--    input_ok=true). Without these partial indexes, every "tested" check does
--    a full seq-scan of app.battle. With hundreds of thousands of battles,
--    this becomes the hottest query in the system.
--
-- 3. idx_code_select_enroll_id: POST /enroll/:eid/code does
--    DELETE FROM code_select WHERE enroll_id=$1, which needs to find rows by
--    enroll_id quickly. Also used in the snapshot selection queries that JOIN
--    code_select.
--
-- 4. idx_execution_log_battle_id: Admin / admin debugging needs to find all
--    execution_log rows for a given battle_id (e.g. to check how many times
--    the Lambda retried).

CREATE INDEX IF NOT EXISTS idx_snapshot_code_id_created_at
    ON app.snapshot (code_id, created_at_utc DESC);

CREATE INDEX IF NOT EXISTS idx_battle_a_snapshot_id
    ON app.battle (a_snapshot_id)
    WHERE infra_ok = true AND input_ok = true;

CREATE INDEX IF NOT EXISTS idx_battle_b_snapshot_id
    ON app.battle (b_snapshot_id)
    WHERE infra_ok = true AND input_ok = true;

CREATE INDEX IF NOT EXISTS idx_code_select_enroll_id
    ON app.code_select (enroll_id);

CREATE INDEX IF NOT EXISTS idx_execution_log_battle_id
    ON app.execution_log (battle_id);
