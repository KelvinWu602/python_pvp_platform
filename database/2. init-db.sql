CREATE SCHEMA app;

CREATE TYPE app.user_role AS ENUM ('user', 'root');

CREATE TABLE app.user (
    id uuid PRIMARY KEY,
    username varchar(20) UNIQUE NOT NULL,
    full_name varchar(50) NOT NULL,
    hash_password varchar(256) NOT NULL,
    urole app.user_role NOT NULL DEFAULT 'user',
    created_at_utc timestamp NOT NULL DEFAULT now(),
    updated_at_utc timestamp NOT NULL DEFAULT now()
);

CREATE TABLE app.user_session (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES app.user(id),
    created_at_utc timestamp NOT NULL DEFAULT now(),
    expire_at_utc timestamp NOT NULL DEFAULT now()
);

-- npc_user_id = the user that plays the NPC role in this competition
CREATE TABLE app.competition (
    id uuid PRIMARY KEY,
    display_name varchar(20) NOT NULL,
    description text NOT NULL,
    start_time_utc timestamp NOT NULL,
    end_time_utc timestamp NOT NULL,
    game_reference text NOT NULL,
    helper_reference text NOT NULL,
    manifest_reference text NOT NULL,
    npc_user_id uuid NOT NULL REFERENCES app.user(id),
    created_at_utc timestamp NOT NULL DEFAULT now(),
    updated_at_utc timestamp NOT NULL DEFAULT now()
);

-- code belongs to user, not enroll — user writes code independently.
--
-- updated_at_utc is denormalized and maintained by
-- trg_snapshot_bumps_code_updated (see 4. triggers.sql). It reflects the
-- created_at_utc of this code's newest snapshot, or the code's own
-- created_at_utc when no snapshots exist yet. This lets
-- GET /enroll/:eid/code list codes in "most recently edited" order with a
-- plain index scan instead of a LATERAL join into app.snapshot.
CREATE TABLE app.code (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES app.user(id),
    competition_id uuid NOT NULL REFERENCES app.competition(id),
    name varchar(50) NOT NULL,
    created_at_utc timestamp NOT NULL DEFAULT now(),
    updated_at_utc timestamp NOT NULL DEFAULT now()
);

-- snapshot is an immutable point-in-time capture of a code's source text.
--
-- latest_test_battle_id / latest_test_status / tested_at_utc are denormalized
-- test state, maintained by trg_battle_maintains_snapshot_test_state
-- (see 4. triggers.sql). They eliminate the LATERAL + EXISTS pattern that
-- previously drove GET /code/:cid/snapshot.
--
-- Only tests (battle rows with is_test=true) affect these fields, and the
-- user's snapshot only ever appears on the 'a' side in tests.
CREATE TABLE app.snapshot (
    id uuid PRIMARY KEY,
    code_id uuid NOT NULL REFERENCES app.code(id),
    code text NOT NULL,
    created_at_utc timestamp NOT NULL DEFAULT now(),
    latest_test_battle_id uuid,  -- FK added after app.battle is created (below)
    latest_test_status text
        CHECK (latest_test_status IN ('pending','success','user_error','infra_error')),
    tested_at_utc timestamp
);

-- enroll = a user's participation in a competition. selected_code_id is a
-- nullable FK to the code the user has chosen as their competition entry
-- (was formerly stored in app.code_select — collapsed here because the
-- invariant is exactly "at most one selected code per enrollment").
--
-- Cross-consistency (selected code must belong to this enrollment's user and
-- competition) is enforced at the application layer in the route handler for
-- PUT /enroll/:eid/code/selected.
CREATE TABLE app.enroll (
    id uuid PRIMARY KEY,
    competition_id uuid NOT NULL REFERENCES app.competition(id),
    user_id uuid NOT NULL REFERENCES app.user(id),
    selected_code_id uuid REFERENCES app.code(id),
    win_count int NOT NULL DEFAULT 0,
    lose_count int NOT NULL DEFAULT 0,
    tie_count int NOT NULL DEFAULT 0,
    UNIQUE (competition_id, user_id)
);

CREATE TABLE app.battle (
    id uuid PRIMARY KEY,
    competition_id uuid NOT NULL REFERENCES app.competition(id),
    is_test boolean NOT NULL DEFAULT false,
    a_user_id uuid NOT NULL REFERENCES app.user(id),
    a_snapshot_id uuid NOT NULL REFERENCES app.snapshot(id),
    b_user_id uuid NOT NULL REFERENCES app.user(id),
    b_snapshot_id uuid NOT NULL REFERENCES app.snapshot(id),
    infra_ok boolean,
    input_ok boolean,
    draw boolean,
    winner_user_id uuid REFERENCES app.user(id),
    loser_user_id uuid REFERENCES app.user(id),
    video_reference text,
    a_stdout_log text,
    a_stderr_log text,
    b_stdout_log text,
    b_stderr_log text,
    created_at_utc timestamp NOT NULL DEFAULT now(),
    updated_at_utc timestamp NOT NULL DEFAULT now()
);

CREATE TABLE app.execution_log (
    id uuid PRIMARY KEY,
    battle_id uuid NOT NULL REFERENCES app.battle(id),
    lambda_request_id text NOT NULL,
    start_time_utc timestamp NOT NULL DEFAULT now()
);

-- Circular FK between app.snapshot and app.battle: snapshot references the
-- battle that tested it, battle references the snapshots it ran. Add
-- snapshot's FK after both tables exist.
ALTER TABLE app.snapshot
    ADD CONSTRAINT snapshot_latest_test_battle_id_fkey
    FOREIGN KEY (latest_test_battle_id) REFERENCES app.battle(id);
