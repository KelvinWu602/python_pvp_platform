-- to be executed in db python_pvp
CREATE SCHEMA app;

CREATE TABLE app.game (
    id uuid PRIMARY KEY,
    name varchar(20) NOT NULL,
    display_name varchar(20) NOT NULL,
    simulator_reference text NOT NULL,
    renderer_reference text NOT NULL,
    created_at_utc  timestamp NOT NULL, -- auto gen
    updated_at_utc timestamp NOT NULL --auto gen
);

CREATE TABLE app.competition (
    id uuid PRIMARY KEY,
    game_id uuid references app.game(id),
    name varchar(20) NOT NULL,
    display_name varchar(20) NOT NULL,
    start_time_utc  timestamp NOT NULL, 
    end_time_utc timestamp NOT NULL,
    enabled bool DEFAULT FALSE
);

CREATE TABLE app.user (
    id uuid PRIMARY KEY,
    sso_id uuid NOT NULL,
    username varchar(20) NOT NULL,
    full_name varchar(50) NOT NULL,
    created_at_utc timestamp NOT NULL,
    updated_at_utc timestamp NOT NULL
);

CREATE TABLE app.enroll (
    id uuid PRIMARY KEY,
    competition_id uuid references app.competition(id),
    user_id uuid references app.user(id),
    selected_code_id uuid   --nullable, because user may have no code at the beginning
);

CREATE TABLE app.code (
    id uuid PRIMARY KEY,
    enroll_id uuid references app.enroll(id),
    name varchar(20) NOT NULL,
    code_reference text NOT NULL
);

CREATE TABLE app.battle (
    id uuid PRIMARY KEY,
    a_enroll_id uuid references app.enroll(id),
    b_enroll_id uuid references app.enroll(id),
    a_code_id   uuid NOT NULL, -- freeze after creation to allow replay
    b_code_id   uuid NOT NULL,
    created_at_utc timestamp NOT NULL,
    updated_at_utc timestamp NOT NULL
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
    winner_score_gain float DEFAULT 0,    
    loser_score_loss float DEFAULT 0,    
    created_at_utc timestamp NOT NULL,
    updated_at_utc timestamp NOT NULL
);

CREATE TABLE app.render_jobs (
    id uuid PRIMARY KEY,
    battle_id uuid references app.battle(id),
    status app.job_status DEFAULT 'pending',
    battle_video_reference text,
    created_at_utc timestamp NOT NULL,
    updated_at_utc timestamp NOT NULL
)
