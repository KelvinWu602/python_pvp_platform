CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

ALTER TABLE app.competition ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE app.user ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE app.user_session ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE app.code ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE app.snapshot ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE app.enroll ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE app.battle ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE app.execution_log ALTER COLUMN id SET DEFAULT gen_random_uuid();
