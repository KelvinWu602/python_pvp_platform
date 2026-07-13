-- 4. triggers.sql
--
-- Two families of triggers:
--
--   1. set_updated_at_utc — the classic auto-bump of updated_at_utc on
--      UPDATE. Applied to app.user, app.competition, app.battle.
--
--   2. Denormalization triggers that keep the summary columns in sync so
--      the user-facing API can read them with plain SELECTs instead of
--      LATERAL joins / correlated EXISTS. See API_elegant.md §13 for the
--      full list of fields these maintain.
--
--        - trg_snapshot_bumps_code_updated:
--            on INSERT INTO app.snapshot → bump app.code.updated_at_utc.
--
--        - trg_battle_maintains_snapshot_test_state:
--            on INSERT/UPDATE of app.battle (is_test=true only)
--            → maintain app.snapshot.latest_test_battle_id /
--              latest_test_status / tested_at_utc for the user's side
--              (a_snapshot_id). The UPDATE branch guards with
--              latest_test_battle_id = NEW.id so a late DLQ retry cannot
--              stomp fresher state after the user launched another test.


-- ─── 1. updated_at_utc auto-bump ─────────────────────────────────────

CREATE OR REPLACE FUNCTION app.set_updated_at_utc()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at_utc = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_user_updated_at_utc
    BEFORE UPDATE ON app.user
    FOR EACH ROW
    EXECUTE FUNCTION app.set_updated_at_utc();

CREATE TRIGGER trg_competition_updated_at_utc
    BEFORE UPDATE ON app.competition
    FOR EACH ROW
    EXECUTE FUNCTION app.set_updated_at_utc();

CREATE TRIGGER trg_battle_updated_at_utc
    BEFORE UPDATE ON app.battle
    FOR EACH ROW
    EXECUTE FUNCTION app.set_updated_at_utc();


-- ─── 2a. app.snapshot INSERT → bump app.code.updated_at_utc ──────────

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


-- ─── 2b. app.battle INSERT/UPDATE → maintain snapshot test state ─────

-- On INSERT of a test battle (is_test=true), mark the user's snapshot as
-- 'pending' and point latest_test_battle_id at this battle.
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


-- On UPDATE that transitions infra_ok from NULL to a concrete value, resolve
-- the snapshot's test_status. Guarded by latest_test_battle_id = NEW.id so
-- late DLQ retries on stale battles cannot overwrite fresher state.
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
                 ELSE s.tested_at_utc  -- preserve prior success timestamp
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
