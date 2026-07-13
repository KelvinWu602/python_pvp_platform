-- 6. migrate-to-denorm.sql
--
-- One-time migration from the pre-denormalization schema to the target
-- schema described by files 2., 4., 5. of this directory + API_elegant.md.
--
-- Wrapped in a single transaction: if anything fails, nothing changes.
--
-- What this script does, in order:
--   Step 1. Add the new columns (nullable, so existing rows remain valid).
--   Step 2. Backfill app.code.updated_at_utc from newest snapshot per code
--           (fallback to code.created_at_utc when the code has no snapshots).
--   Step 3. Backfill app.snapshot.latest_test_* / tested_at_utc from the
--           newest is_test=true battle referencing each snapshot.
--   Step 4. Backfill app.enroll.selected_code_id from app.code_select.
--   Step 5. Drop app.code_select and obsolete indexes.
--   Step 6. Create the new indexes.
--   Step 7. Install the FK constraint on snapshot.latest_test_battle_id,
--           and install the denormalization triggers.
--
-- Data-consistency assumptions:
--   - app.code_select has at most one row per enroll_id (enforced today by
--     the application's DELETE-then-INSERT pattern). If duplicates exist,
--     step 4 will error out on the ON CONFLICT-less UPDATE; investigate
--     manually before rerunning.
--   - Existing rows in app.code have created_at_utc — used as the
--     updated_at_utc fallback when no snapshots exist.
--   - A snapshot's user-side test only ever appears as a_snapshot_id (the
--     b_snapshot_id in tests is always the NPC's). Backfill mirrors this.

BEGIN;

-- ─── Step 1. Add new columns (nullable / defaulted) ───────────────────────

ALTER TABLE app.code
    ADD COLUMN updated_at_utc timestamp NOT NULL DEFAULT now();

ALTER TABLE app.snapshot
    ADD COLUMN latest_test_battle_id uuid,
    ADD COLUMN latest_test_status text
        CHECK (latest_test_status IN ('pending','success','user_error','infra_error')),
    ADD COLUMN tested_at_utc timestamp;

ALTER TABLE app.enroll
    ADD COLUMN selected_code_id uuid REFERENCES app.code(id);


-- ─── Step 2. Backfill app.code.updated_at_utc ─────────────────────────────

UPDATE app.code c
   SET updated_at_utc = COALESCE(
       (SELECT MAX(s.created_at_utc)
          FROM app.snapshot s
         WHERE s.code_id = c.id),
       c.created_at_utc
   );


-- ─── Step 3. Backfill snapshot test state from latest is_test battle ──────

WITH latest_test AS (
    SELECT DISTINCT ON (b.a_snapshot_id)
           b.a_snapshot_id AS snapshot_id,
           b.id            AS battle_id,
           b.infra_ok,
           b.input_ok,
           b.updated_at_utc
      FROM app.battle b
     WHERE b.is_test = true
     ORDER BY b.a_snapshot_id, b.created_at_utc DESC
)
UPDATE app.snapshot s
   SET latest_test_battle_id = lt.battle_id,
       latest_test_status    = CASE
           WHEN lt.infra_ok IS NULL                            THEN 'pending'
           WHEN lt.infra_ok = true AND lt.input_ok = true      THEN 'success'
           WHEN lt.infra_ok = true AND lt.input_ok = false     THEN 'user_error'
           ELSE 'infra_error'
       END,
       tested_at_utc = CASE
           WHEN lt.infra_ok = true AND lt.input_ok = true
               THEN lt.updated_at_utc
           ELSE NULL
       END
  FROM latest_test lt
 WHERE s.id = lt.snapshot_id;


-- ─── Step 4. Backfill app.enroll.selected_code_id from app.code_select ────

UPDATE app.enroll e
   SET selected_code_id = cs.code_id
  FROM app.code_select cs
 WHERE cs.enroll_id = e.id;


-- ─── Step 5. Drop obsolete table and indexes ──────────────────────────────

DROP INDEX IF EXISTS app.idx_code_select_enroll_id;
DROP INDEX IF EXISTS app.idx_battle_a_snapshot_id;
DROP INDEX IF EXISTS app.idx_battle_b_snapshot_id;

DROP TABLE app.code_select;


-- ─── Step 6. Create new indexes ───────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_code_user_competition_updated_at
    ON app.code (user_id, competition_id, updated_at_utc DESC);

CREATE INDEX IF NOT EXISTS idx_snapshot_success_by_code
    ON app.snapshot (code_id)
    WHERE latest_test_status = 'success';

CREATE INDEX IF NOT EXISTS idx_enroll_competition_selected_code
    ON app.enroll (competition_id, selected_code_id);


-- ─── Step 7. Install FK + denormalization triggers ────────────────────────

ALTER TABLE app.snapshot
    ADD CONSTRAINT snapshot_latest_test_battle_id_fkey
    FOREIGN KEY (latest_test_battle_id) REFERENCES app.battle(id);


CREATE OR REPLACE FUNCTION app.snapshot_bumps_code_updated()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE app.code
       SET updated_at_utc = NEW.created_at_utc
     WHERE id = NEW.code_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_snapshot_bumps_code_updated
    AFTER INSERT ON app.snapshot
    FOR EACH ROW
    EXECUTE FUNCTION app.snapshot_bumps_code_updated();


CREATE OR REPLACE FUNCTION app.battle_insert_sets_snapshot_pending()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.is_test = true THEN
        UPDATE app.snapshot
           SET latest_test_battle_id = NEW.id,
               latest_test_status    = 'pending'
         WHERE id = NEW.a_snapshot_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_battle_insert_sets_snapshot_pending
    AFTER INSERT ON app.battle
    FOR EACH ROW
    EXECUTE FUNCTION app.battle_insert_sets_snapshot_pending();


CREATE OR REPLACE FUNCTION app.battle_update_resolves_snapshot_status()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.is_test = true
       AND OLD.infra_ok IS NULL
       AND NEW.infra_ok IS NOT NULL THEN
        UPDATE app.snapshot s
           SET latest_test_status = CASE
                 WHEN NEW.infra_ok = true AND NEW.input_ok = true  THEN 'success'
                 WHEN NEW.infra_ok = true AND NEW.input_ok = false THEN 'user_error'
                 ELSE 'infra_error'
               END,
               tested_at_utc = CASE
                 WHEN NEW.infra_ok = true AND NEW.input_ok = true
                     THEN NEW.updated_at_utc
                 ELSE s.tested_at_utc
               END
         WHERE s.id = NEW.a_snapshot_id
           AND s.latest_test_battle_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_battle_update_resolves_snapshot_status
    AFTER UPDATE ON app.battle
    FOR EACH ROW
    EXECUTE FUNCTION app.battle_update_resolves_snapshot_status();


COMMIT;
