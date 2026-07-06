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
