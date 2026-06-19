-- to be executed in db python_pvp
CREATE SCHEMA app;

CREATE TABLE app.game (
    id uuid PRIMARY KEY,
    display_name varchar(20) NOT NULL,
    simulation_reference text NOT NULL,
    created_at_utc  timestamp NOT NULL DEFAULT now(), -- auto gen
    updated_at_utc timestamp NOT NULL DEFAULT now() --auto gen
);

CREATE TABLE app.competition (
    id uuid PRIMARY KEY,
    game_id uuid references app.game(id),
    display_name varchar(20) NOT NULL,
    start_time_utc  timestamp NOT NULL, 
    end_time_utc timestamp NOT NULL,
    enabled bool DEFAULT FALSE
);

CREATE TYPE app.user_role AS ENUM (
    'user',
    'root'
);

CREATE TABLE app.user (
    id uuid PRIMARY KEY,
    username varchar(20) NOT NULL,
    full_name varchar(50) NOT NULL,
    created_at_utc timestamp NOT NULL DEFAULT now(),
    updated_at_utc timestamp NOT NULL DEFAULT now(),
    hash_password varchar(256) NOT NULL,
    urole app.user_role NOT NULL DEFAULT 'user'
);

CREATE TABLE app.user_session (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    created_at_utc timestamp NOT NULL DEFAULT now(),
    expire_at_utc timestamp NOT NULL DEFAULT now()
);

CREATE TABLE app.enroll (
    id uuid PRIMARY KEY,
    competition_id uuid references app.competition(id),
    user_id uuid references app.user(id),
    selected_code_id uuid,   --nullable, because user may have no code at the beginning
    -- a user enrolls in a given competition at most once; the enroll/battle
    -- logic assumes a single (competition_id, user_id) row exists.
    UNIQUE (competition_id, user_id)
);

CREATE TABLE app.code (
    id uuid PRIMARY KEY,
    enroll_id uuid references app.enroll(id),
    name varchar(20) NOT NULL,
    code text NOT NULL
);

CREATE TABLE app.battle (
    id uuid PRIMARY KEY,
    a_enroll_id uuid references app.enroll(id),
    b_enroll_id uuid references app.enroll(id),
    a_code_id   uuid NOT NULL, -- freeze after creation to allow replay
    b_code_id   uuid NOT NULL,
    created_at_utc timestamp NOT NULL DEFAULT now(),
    updated_at_utc timestamp NOT NULL DEFAULT now()
);

CREATE TYPE app.job_status AS ENUM (
    'pending',
    'completed',
    'failed'
);

CREATE TABLE app.simulation_job (
    id uuid PRIMARY KEY,
    battle_id uuid references app.battle(id),
    status app.job_status DEFAULT 'pending',
    winner_user_id uuid,       -- can be null
    loser_user_id uuid,
    winner_score_gain float DEFAULT 0,    
    loser_score_loss float DEFAULT 0,    
    battle_video_reference text,
    execution_log text,
    created_at_utc timestamp NOT NULL DEFAULT now(),
    updated_at_utc timestamp NOT NULL DEFAULT now()
);
