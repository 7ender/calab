-- Outbound OIDC credentials never reuse first-party sessions or JWT signing keys.
-- +goose Up
CREATE TABLE oauth_clients (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    client_id text NOT NULL UNIQUE,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    client_type text NOT NULL CHECK (client_type IN ('confidential_web', 'public_native', 'public_spa')),
    refresh_enabled boolean NOT NULL DEFAULT false,
    allowed_origins text[] NOT NULL DEFAULT ARRAY[]::text[],
    auth_method text NOT NULL CHECK (auth_method IN ('none', 'client_secret_basic')),
    scopes text[] NOT NULL DEFAULT ARRAY['openid'] CHECK (scopes <@ ARRAY['openid', 'profile', 'email']::text[] AND 'openid' = ANY(scopes)),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    disabled_at timestamptz,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, id),
    CHECK ((client_type IN ('public_native', 'public_spa') AND auth_method = 'none') OR
           (client_type = 'confidential_web' AND auth_method = 'client_secret_basic'))
);
CREATE TABLE oauth_client_redirects (
    workspace_id uuid NOT NULL,
    client_id uuid NOT NULL,
    redirect_uri text NOT NULL CHECK (char_length(redirect_uri) BETWEEN 1 AND 2048),
    PRIMARY KEY (workspace_id, client_id, redirect_uri),
    FOREIGN KEY (workspace_id, client_id) REFERENCES oauth_clients(workspace_id, id) ON DELETE CASCADE
);
CREATE TABLE oauth_client_secrets (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL,
    client_id uuid NOT NULL,
    secret_hash bytea NOT NULL UNIQUE CHECK (octet_length(secret_hash) = 32),
    created_at timestamptz NOT NULL DEFAULT now(),
    valid_until timestamptz NOT NULL,
    revoked_at timestamptz,
    FOREIGN KEY (workspace_id, client_id) REFERENCES oauth_clients(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX oauth_client_secrets_client_idx ON oauth_client_secrets(workspace_id, client_id);
CREATE TABLE oauth_subjects (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject text NOT NULL UNIQUE CHECK (char_length(subject) BETWEEN 32 AND 128),
    PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE oauth_consents (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id uuid NOT NULL,
    scopes text[] NOT NULL CHECK (scopes <@ ARRAY['openid', 'profile', 'email']::text[] AND 'openid' = ANY(scopes)),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    refresh_allowed boolean NOT NULL DEFAULT false,
    granted_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    FOREIGN KEY (workspace_id, client_id) REFERENCES oauth_clients(workspace_id, id) ON DELETE CASCADE,
    UNIQUE (workspace_id, user_id, client_id),
    UNIQUE (workspace_id, id, user_id, client_id)
);
CREATE TABLE oauth_authorization_requests (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL,
    client_id uuid NOT NULL,
    issuer text NOT NULL,
    client_version bigint NOT NULL,
    handle_hash bytea NOT NULL UNIQUE CHECK (octet_length(handle_hash) = 32),
    browser_hash bytea NOT NULL CHECK (octet_length(browser_hash) = 32),
    csrf_hash bytea CHECK (csrf_hash IS NULL OR octet_length(csrf_hash) = 32),
    session_id uuid,
    user_id uuid,
    redirect_uri text NOT NULL,
    scopes text[] NOT NULL CHECK (scopes <@ ARRAY['openid', 'profile', 'email']::text[] AND 'openid' = ANY(scopes)),
    state text NOT NULL CHECK (octet_length(state) BETWEEN 1 AND 512),
    nonce text NOT NULL CHECK (octet_length(nonce) BETWEEN 1 AND 512),
    pkce_challenge text NOT NULL CHECK (pkce_challenge ~ '^[A-Za-z0-9_-]{43}$'),
    prompt text NOT NULL DEFAULT '',
    max_age_seconds integer CHECK (max_age_seconds >= 0),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (workspace_id, client_id) REFERENCES oauth_clients(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (session_id, user_id) REFERENCES sessions(id, user_id) ON DELETE CASCADE,
    CHECK ((session_id IS NULL) = (user_id IS NULL))
);
CREATE INDEX oauth_authorization_requests_client_idx ON oauth_authorization_requests(workspace_id, client_id);
CREATE INDEX oauth_authorization_requests_expiry_idx ON oauth_authorization_requests(expires_at);
CREATE TABLE oauth_grants (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    client_id uuid NOT NULL,
    consent_id uuid NOT NULL,
    session_id uuid NOT NULL,
    scopes text[] NOT NULL CHECK (scopes <@ ARRAY['openid', 'profile', 'email']::text[] AND 'openid' = ANY(scopes)),
    issuer text NOT NULL,
    client_version bigint NOT NULL,
    consent_version bigint NOT NULL,
    policy_version bigint NOT NULL,
    access_version bigint NOT NULL,
    entitlement_version bigint NOT NULL,
    session_version bigint NOT NULL,
    authenticated_at timestamptz NOT NULL,
    assurance_expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    idle_expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    revoked_reason text,
    FOREIGN KEY (workspace_id, consent_id, user_id, client_id) REFERENCES oauth_consents(workspace_id, id, user_id, client_id) ON DELETE CASCADE,
    FOREIGN KEY (session_id, user_id) REFERENCES sessions(id, user_id) ON DELETE CASCADE,
    UNIQUE (workspace_id, id, user_id, client_id),
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '8 hours'),
    CHECK (idle_expires_at <= expires_at)
);
CREATE INDEX oauth_grants_session_idx ON oauth_grants(session_id);
CREATE INDEX oauth_grants_client_idx ON oauth_grants(workspace_id, client_id);
CREATE INDEX oauth_grants_user_idx ON oauth_grants(workspace_id, user_id);
CREATE INDEX oauth_grants_consent_idx ON oauth_grants(consent_id);
CREATE TABLE oauth_authorization_codes (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL,
    grant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    client_id uuid NOT NULL,
    code_hash bytea NOT NULL UNIQUE CHECK (octet_length(code_hash) = 32),
    redirect_uri text NOT NULL,
    pkce_challenge text NOT NULL CHECK (pkce_challenge ~ '^[A-Za-z0-9_-]{43}$'),
    nonce text NOT NULL CHECK (octet_length(nonce) BETWEEN 1 AND 512),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    FOREIGN KEY (workspace_id, grant_id, user_id, client_id) REFERENCES oauth_grants(workspace_id, id, user_id, client_id) ON DELETE CASCADE,
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '60 seconds')
);
CREATE INDEX oauth_authorization_codes_grant_idx ON oauth_authorization_codes(grant_id);
CREATE TABLE oauth_tokens (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL,
    grant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    client_id uuid NOT NULL,
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    token_type text NOT NULL CHECK (token_type IN ('access', 'refresh')),
    generation bigint NOT NULL CHECK (generation > 0),
    parent_token_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    revoked_at timestamptz,
    FOREIGN KEY (workspace_id, grant_id, user_id, client_id) REFERENCES oauth_grants(workspace_id, id, user_id, client_id) ON DELETE CASCADE,
    UNIQUE (grant_id, token_type, generation),
    UNIQUE (workspace_id, grant_id, user_id, client_id, id),
    FOREIGN KEY (workspace_id, grant_id, user_id, client_id, parent_token_id) REFERENCES oauth_tokens(workspace_id, grant_id, user_id, client_id, id) ON DELETE CASCADE,
    CHECK (expires_at > created_at),
    CHECK (token_type <> 'access' OR expires_at <= created_at + interval '5 minutes')
);
CREATE INDEX oauth_tokens_client_idx ON oauth_tokens(workspace_id, client_id);
CREATE INDEX oauth_tokens_expiry_idx ON oauth_tokens(expires_at);
-- +goose StatementBegin
CREATE FUNCTION oauth_immutable_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME = 'oauth_subjects' THEN
        IF (NEW.workspace_id,NEW.user_id,NEW.subject) IS DISTINCT FROM (OLD.workspace_id,OLD.user_id,OLD.subject) THEN
            RAISE EXCEPTION 'OAuth subject is immutable' USING ERRCODE = '23514';
        END IF;
    ELSIF (NEW.workspace_id,NEW.client_id,NEW.client_type,NEW.auth_method) IS DISTINCT FROM (OLD.workspace_id,OLD.client_id,OLD.client_type,OLD.auth_method) THEN
        RAISE EXCEPTION 'OAuth client identity is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
-- +goose StatementEnd
CREATE TRIGGER oauth_subject_identity_guard BEFORE UPDATE ON oauth_subjects FOR EACH ROW EXECUTE FUNCTION oauth_immutable_identity_guard();
CREATE TRIGGER oauth_client_identity_guard BEFORE UPDATE ON oauth_clients FOR EACH ROW EXECUTE FUNCTION oauth_immutable_identity_guard();

-- +goose Down
DROP TRIGGER oauth_subject_identity_guard ON oauth_subjects;
DROP TRIGGER oauth_client_identity_guard ON oauth_clients;
DROP FUNCTION oauth_immutable_identity_guard();
DROP TABLE oauth_tokens, oauth_authorization_codes, oauth_grants,
    oauth_authorization_requests, oauth_consents, oauth_subjects, oauth_client_secrets,
    oauth_client_redirects, oauth_clients;
