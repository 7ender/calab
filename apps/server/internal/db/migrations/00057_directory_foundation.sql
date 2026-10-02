-- LDAPS sync is an eligibility source, never a password authentication mechanism.
-- +goose Up
-- New tables only; their foreign keys briefly lock workspaces/users. Fail fast instead of
-- queueing behind a long transaction during a rolling deploy (see 00055).
SET LOCAL lock_timeout = '10s';
CREATE TABLE workspace_directories (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL,
    host text NOT NULL,
    url text NOT NULL,
    allowed_group_dns text[] NOT NULL DEFAULT ARRAY[]::text[],
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
    port integer NOT NULL DEFAULT 636 CHECK (port = 636),
    base_dn text NOT NULL,
    bind_dn text NOT NULL,
    bind_secret_box bytea NOT NULL,
    ca_pem text NOT NULL DEFAULT '',
    sync_interval_seconds integer NOT NULL DEFAULT 300 CHECK (sync_interval_seconds BETWEEN 60 AND 3600),
    max_staleness_seconds integer NOT NULL DEFAULT 3600 CHECK (max_staleness_seconds BETWEEN 300 AND 3600),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    last_success_at timestamptz,
    cursor_box bytea,
    last_error text NOT NULL DEFAULT '',
    disabled_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, id),
    UNIQUE (workspace_id)
);
CREATE TABLE directory_sync_runs (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL,
    directory_id uuid NOT NULL,
    full_scan boolean NOT NULL,
    config_version bigint NOT NULL,
    generation bigint NOT NULL,
    lease_until timestamptz NOT NULL,
    status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'quarantined')),
    complete boolean NOT NULL DEFAULT false,
    objects_seen integer NOT NULL DEFAULT 0 CHECK (objects_seen >= 0),
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    FOREIGN KEY (workspace_id, directory_id) REFERENCES workspace_directories(workspace_id, id) ON DELETE CASCADE,
    UNIQUE (workspace_id, directory_id, id),
    CHECK (NOT complete OR status = 'succeeded')
);
CREATE INDEX directory_sync_runs_directory_idx ON directory_sync_runs(workspace_id, directory_id, started_at DESC);
CREATE TABLE directory_objects (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL,
    directory_id uuid NOT NULL,
    object_guid uuid NOT NULL,
    user_id uuid REFERENCES users(id) ON DELETE CASCADE,
    distinguished_name text NOT NULL,
    status text NOT NULL CHECK (status IN ('active', 'disabled', 'deleted', 'unmapped')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    last_seen_run_id uuid,
    missing_full_scans integer NOT NULL DEFAULT 0 CHECK (missing_full_scans >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (workspace_id, directory_id) REFERENCES workspace_directories(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, directory_id, last_seen_run_id) REFERENCES directory_sync_runs(workspace_id, directory_id, id),
    UNIQUE (workspace_id, directory_id, object_guid),
    UNIQUE (workspace_id, id),
    UNIQUE (workspace_id, directory_id, user_id)
);
CREATE INDEX directory_objects_user_idx ON directory_objects(workspace_id, user_id);
CREATE TABLE directory_sync_objects (
    workspace_id uuid NOT NULL,
    directory_id uuid NOT NULL,
    run_id uuid NOT NULL,
    object_guid uuid NOT NULL,
    distinguished_name text NOT NULL,
    eligible boolean NOT NULL,
    disabled boolean NOT NULL,
    PRIMARY KEY (run_id, object_guid),
    FOREIGN KEY (workspace_id, directory_id, run_id) REFERENCES directory_sync_runs(workspace_id, directory_id, id) ON DELETE CASCADE
);
-- +goose Down
SET LOCAL lock_timeout = '10s';
DROP TABLE directory_sync_objects, directory_objects, directory_sync_runs, workspace_directories;
