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

-- code belongs to user, not enroll — user writes code independently
CREATE TABLE app.code (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES app.user(id),
    name varchar(50) NOT NULL,
    created_at_utc timestamp NOT NULL DEFAULT now()
);

CREATE TABLE app.snapshot (
    id uuid PRIMARY KEY,
    code_id uuid NOT NULL REFERENCES app.code(id),
    code text NOT NULL,
    created_at_utc timestamp NOT NULL DEFAULT now()
);

-- admin_user_id = the user who owns this competition and acts as NPC
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

CREATE TABLE app.enroll (
    id uuid PRIMARY KEY,
    competition_id uuid NOT NULL REFERENCES app.competition(id),
    user_id uuid NOT NULL REFERENCES app.user(id),
    win_count int NOT NULL DEFAULT 0,
    lose_count int NOT NULL DEFAULT 0,
    tie_count int NOT NULL DEFAULT 0,
    UNIQUE (competition_id, user_id)
);

-- sole link between enroll and code
CREATE TABLE app.code_select (
    enroll_id uuid NOT NULL REFERENCES app.enroll(id),
    code_id uuid NOT NULL REFERENCES app.code(id),
    user_id uuid NOT NULL REFERENCES app.user(id),
    competition_id uuid NOT NULL REFERENCES app.competition(id),
    PRIMARY KEY (enroll_id, code_id)
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
    created_at_utc timestamp NOT NULL DEFAULT now(),
    updated_at_utc timestamp NOT NULL DEFAULT now()
);

CREATE TABLE app.execution_log (
    id uuid PRIMARY KEY,
    battle_id uuid NOT NULL REFERENCES app.battle(id),
    lambda_request_id text NOT NULL,
    start_time_utc timestamp NOT NULL DEFAULT now()
);
