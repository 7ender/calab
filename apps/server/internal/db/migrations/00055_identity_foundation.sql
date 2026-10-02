-- Identity trust is workspace-scoped; legacy sessions acquire no proof or entitlement.
-- +goose Up
-- Rollout safety (several replicas, live traffic): never queue behind a long transaction while
-- holding/awaiting ACCESS EXCLUSIVE on sessions — that blocks every login and refresh. A busy
-- table fails the migration after 10 s instead; the advisory-locked migrate is simply retried.
SET LOCAL lock_timeout = '10s';
-- New columns with constant defaults are a catalog-only change. Their checks are added
-- NOT VALID: every existing row holds the defaults (local_account, NULL scope, version 1), which
-- satisfy them, so no full scan runs under ACCESS EXCLUSIVE; new and updated rows are checked.
ALTER TABLE sessions ADD COLUMN authority_kind text NOT NULL DEFAULT 'local_account',
    ADD COLUMN authority_workspace_id uuid,
    ADD COLUMN authority_connection_id uuid,
    ADD COLUMN local_authenticated_at timestamptz,
    ADD COLUMN recovery_authenticated_at timestamptz,
    ADD COLUMN authority_version bigint NOT NULL DEFAULT 1,
    ADD CONSTRAINT sessions_authority_kind_check CHECK (authority_kind IN ('local_account', 'workspace_sso', 'recovery')) NOT VALID,
    ADD CONSTRAINT sessions_authority_version_check CHECK (authority_version > 0) NOT VALID,
    ADD CONSTRAINT sessions_authority_workspace_id_fkey FOREIGN KEY (authority_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID,
    ADD CONSTRAINT sessions_id_user_key UNIQUE (id, user_id),
    ADD CONSTRAINT sessions_authority_scope CHECK (
        (authority_kind = 'local_account' AND authority_workspace_id IS NULL AND authority_connection_id IS NULL AND recovery_authenticated_at IS NULL) OR
        (authority_kind = 'workspace_sso' AND authority_workspace_id IS NOT NULL AND authority_connection_id IS NOT NULL AND local_authenticated_at IS NULL AND recovery_authenticated_at IS NULL) OR
        (authority_kind = 'recovery' AND authority_workspace_id IS NOT NULL AND authority_connection_id IS NULL AND local_authenticated_at IS NULL AND recovery_authenticated_at IS NOT NULL AND expires_at <= recovery_authenticated_at + interval '10 minutes')) NOT VALID;

-- +goose StatementBegin
CREATE FUNCTION identity_session_origin_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.user_id,NEW.authority_kind,NEW.authority_workspace_id,NEW.authority_connection_id)
       IS DISTINCT FROM (OLD.user_id,OLD.authority_kind,OLD.authority_workspace_id,OLD.authority_connection_id) THEN
        RAISE EXCEPTION 'session identity authority is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
-- +goose StatementEnd
CREATE TRIGGER identity_session_origin_guard_trigger BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION identity_session_origin_guard();

CREATE TABLE workspace_identity_grants (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    feature text NOT NULL CHECK (feature IN ('corporate_sso', 'directory_sync', 'oauth_provider')),
    enabled boolean NOT NULL DEFAULT false,
    source text NOT NULL CHECK (source IN ('cloud_business', 'onprem_enterprise')),
    valid_until timestamptz,
    revoked_at timestamptz,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, feature)
);
CREATE TABLE workspace_identity_policies (
    workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    entitlement_version bigint NOT NULL DEFAULT 1 CHECK (entitlement_version > 0),
    mode text NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'optional', 'enforced')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    assurance_max_age_seconds integer NOT NULL DEFAULT 3600 CHECK (assurance_max_age_seconds BETWEEN 300 AND 3600),
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
-- +goose StatementBegin
CREATE FUNCTION identity_grant_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ws uuid;
BEGIN
    ws := CASE WHEN TG_OP = 'DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
    IF EXISTS (SELECT FROM workspaces WHERE id = ws) THEN
        INSERT INTO workspace_identity_policies(workspace_id, entitlement_version) VALUES(ws, 2)
        ON CONFLICT (workspace_id) DO UPDATE SET entitlement_version = workspace_identity_policies.entitlement_version + 1;
    END IF;
    RETURN NULL;
END $$;
-- +goose StatementEnd
CREATE TRIGGER identity_grant_epoch_trigger AFTER INSERT OR UPDATE OR DELETE ON workspace_identity_grants
    FOR EACH ROW EXECUTE FUNCTION identity_grant_epoch();

CREATE TABLE workspace_identity_connections (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'tested', 'active', 'disabled')),
    tenant_id text NOT NULL DEFAULT '',
    provider text NOT NULL CHECK (provider IN ('entra', 'adfs', 'generic')),
    issuer text NOT NULL CHECK (char_length(issuer) BETWEEN 1 AND 2048),
    client_id text NOT NULL CHECK (char_length(client_id) BETWEEN 1 AND 512),
    client_secret_box bytea,
    scopes text[] NOT NULL DEFAULT ARRAY['openid'],
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    tested_version bigint,
    tested_at timestamptz,
    disabled_at timestamptz,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, id),
    UNIQUE (workspace_id, issuer, client_id)
);
CREATE UNIQUE INDEX workspace_identity_connections_active_idx ON workspace_identity_connections(workspace_id) WHERE status = 'active';
-- NOT VALID: every existing session has a NULL connection (no scan under ACCESS EXCLUSIVE).
ALTER TABLE sessions ADD CONSTRAINT sessions_authority_connection_fkey
    FOREIGN KEY (authority_workspace_id, authority_connection_id)
    REFERENCES workspace_identity_connections(workspace_id, id) ON DELETE CASCADE NOT VALID;
CREATE INDEX sessions_authority_workspace_idx ON sessions(authority_workspace_id) WHERE authority_workspace_id IS NOT NULL;

-- Tombstones deliberately survive membership deletion; email is never a linking key.
CREATE TABLE workspace_external_identities (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    issuer text NOT NULL,
    subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 512),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'unlinked')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    linked_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (workspace_id, connection_id) REFERENCES workspace_identity_connections(workspace_id, id) ON DELETE CASCADE,
    UNIQUE (workspace_id, connection_id, issuer, subject),
    UNIQUE (workspace_id, id, user_id, connection_id)
);
CREATE UNIQUE INDEX workspace_external_identities_active_user_idx ON workspace_external_identities(workspace_id, connection_id, user_id) WHERE status <> 'unlinked';
CREATE INDEX workspace_external_identities_user_idx ON workspace_external_identities(user_id, workspace_id);
CREATE TABLE workspace_identity_access (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    reason text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE session_workspace_assurances (
    session_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    identity_id uuid NOT NULL,
    authenticated_at timestamptz NOT NULL,
    valid_until timestamptz NOT NULL,
    policy_version bigint NOT NULL CHECK (policy_version > 0),
    access_version bigint NOT NULL CHECK (access_version > 0),
    connection_version bigint NOT NULL CHECK (connection_version > 0),
    identity_version bigint NOT NULL CHECK (identity_version > 0),
    entitlement_version bigint NOT NULL CHECK (entitlement_version > 0),
    session_version bigint NOT NULL CHECK (session_version > 0),
    revoked_at timestamptz,
    PRIMARY KEY (session_id, workspace_id),
    FOREIGN KEY (session_id, user_id) REFERENCES sessions(id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_members(workspace_id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, identity_id, user_id, connection_id)
        REFERENCES workspace_external_identities(workspace_id, id, user_id, connection_id) ON DELETE CASCADE,
    CHECK (valid_until > authenticated_at AND valid_until <= authenticated_at + interval '1 hour')
);
CREATE INDEX session_workspace_assurances_user_idx ON session_workspace_assurances(workspace_id, user_id);
CREATE INDEX session_workspace_assurances_connection_idx ON session_workspace_assurances(workspace_id, connection_id);

CREATE TABLE identity_login_transactions (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    connection_version bigint NOT NULL,
    purpose text NOT NULL CHECK (purpose IN ('login', 'link', 'step_up', 'test')),
    session_id uuid,
    user_id uuid,
    state_hash bytea NOT NULL UNIQUE CHECK (octet_length(state_hash) = 32),
    browser_hash bytea NOT NULL CHECK (octet_length(browser_hash) = 32),
    nonce_hash bytea NOT NULL CHECK (octet_length(nonce_hash) = 32),
    verifier_box bytea NOT NULL,
    return_uri text NOT NULL,
    native_challenge text,
    browser_start_hash bytea UNIQUE CHECK (browser_start_hash IS NULL OR octet_length(browser_start_hash) = 32),
    browser_started_at timestamptz,
    result_box bytea,
    completed_at timestamptz,
    finished_at timestamptz,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (workspace_id, connection_id) REFERENCES workspace_identity_connections(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (session_id, user_id) REFERENCES sessions(id, user_id) ON DELETE CASCADE,
    CHECK ((session_id IS NULL) = (user_id IS NULL)),
    CHECK (purpose = 'login' OR session_id IS NOT NULL)
);
CREATE INDEX identity_login_transactions_expiry_idx ON identity_login_transactions(expires_at);
CREATE INDEX identity_login_transactions_connection_idx ON identity_login_transactions(workspace_id, connection_id);
CREATE TABLE identity_native_handoffs (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    transaction_id uuid NOT NULL UNIQUE REFERENCES identity_login_transactions(id) ON DELETE CASCADE,
    ticket_hash bytea NOT NULL UNIQUE CHECK (octet_length(ticket_hash) = 32),
    challenge text NOT NULL,
    result_box bytea NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz
);
CREATE TABLE workspace_identity_recovery_codes (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash bytea NOT NULL UNIQUE CHECK (octet_length(code_hash) = 32),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_identity_recovery_codes_workspace_idx ON workspace_identity_recovery_codes(workspace_id);
CREATE TABLE identity_invalidation_outbox (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id uuid REFERENCES users(id) ON DELETE CASCADE,
    session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
    policy_version bigint NOT NULL,
    access_version bigint NOT NULL DEFAULT 0,
    reason text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    delivered_at timestamptz
);
CREATE INDEX identity_invalidation_pending_idx ON identity_invalidation_outbox(id) WHERE delivered_at IS NULL;
CREATE TABLE workspace_identity_audit (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
    action text NOT NULL,
    target_id uuid,
    outcome text NOT NULL CHECK (outcome IN ('allowed', 'denied', 'changed')),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_identity_audit_workspace_idx ON workspace_identity_audit(workspace_id, id DESC);
-- Product admin grants are operator-controlled; upstream emails never grant this authority.
CREATE TABLE product_admin_grants (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    granted_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    operator_note text NOT NULL DEFAULT ''
);

-- +goose Down
SET LOCAL lock_timeout = '10s';
-- An old binary cannot safely enforce scoped authority or sticky workspace policy.
-- +goose StatementBegin
DO $$ BEGIN
    IF EXISTS (SELECT FROM workspace_identity_policies WHERE mode = 'enforced') OR
       EXISTS (SELECT FROM sessions WHERE authority_kind <> 'local_account' AND revoked_at IS NULL) THEN
        RAISE EXCEPTION 'identity rollback requires disabling enforcement and revoking scoped sessions';
    END IF;
END $$;
-- +goose StatementEnd
DROP TABLE product_admin_grants, workspace_identity_audit, identity_invalidation_outbox,
    workspace_identity_recovery_codes, identity_native_handoffs, identity_login_transactions,
    session_workspace_assurances, workspace_identity_access, workspace_external_identities;
ALTER TABLE sessions DROP CONSTRAINT sessions_authority_connection_fkey;
DROP TABLE workspace_identity_connections;
DROP TRIGGER identity_grant_epoch_trigger ON workspace_identity_grants;
DROP FUNCTION identity_grant_epoch();
DROP TABLE workspace_identity_policies, workspace_identity_grants;
DROP TRIGGER identity_session_origin_guard_trigger ON sessions;
DROP FUNCTION identity_session_origin_guard();
ALTER TABLE sessions DROP CONSTRAINT sessions_authority_scope, DROP CONSTRAINT sessions_id_user_key,
    DROP CONSTRAINT sessions_authority_kind_check, DROP CONSTRAINT sessions_authority_version_check,
    DROP CONSTRAINT sessions_authority_workspace_id_fkey,
    DROP COLUMN authority_kind, DROP COLUMN authority_workspace_id, DROP COLUMN authority_connection_id,
    DROP COLUMN local_authenticated_at, DROP COLUMN recovery_authenticated_at, DROP COLUMN authority_version;
