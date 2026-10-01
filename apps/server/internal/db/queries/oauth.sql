-- Identity v1 foundation, ADR-0054. Consumer mutations run with audit/outbox in one transaction.

-- name: CreateOAuthClient :one
INSERT INTO oauth_clients (workspace_id, client_id, name, client_type, refresh_enabled, allowed_origins, auth_method, scopes, created_by)
VALUES (sqlc.arg('workspace_id'), sqlc.arg('client_id'), sqlc.arg('name'), sqlc.arg('client_type'), sqlc.arg('refresh_enabled'), sqlc.arg('allowed_origins'), sqlc.arg('auth_method'), sqlc.arg('scopes'), sqlc.narg('created_by'))
RETURNING *;

-- name: GetOAuthClient :one
SELECT * FROM oauth_clients WHERE workspace_id = sqlc.arg('workspace_id') AND id = sqlc.arg('id');

-- name: CreateOAuthClientRedirect :one
INSERT INTO oauth_client_redirects (workspace_id, client_id, redirect_uri)
VALUES (sqlc.arg('workspace_id'), sqlc.arg('client_id'), sqlc.arg('redirect_uri'))
RETURNING *;

-- name: GetOAuthClientRedirect :one
SELECT * FROM oauth_client_redirects WHERE workspace_id = sqlc.arg('workspace_id') AND client_id = sqlc.arg('client_id') AND redirect_uri = sqlc.arg('redirect_uri');

-- name: CreateOAuthClientSecret :one
INSERT INTO oauth_client_secrets (workspace_id, client_id, secret_hash, valid_until)
VALUES (sqlc.arg('workspace_id'), sqlc.arg('client_id'), sqlc.arg('secret_hash'), sqlc.arg('valid_until'))
RETURNING *;

-- name: GetOAuthClientSecret :one
SELECT * FROM oauth_client_secrets WHERE workspace_id = sqlc.arg('workspace_id') AND id = sqlc.arg('id');

-- name: CreateOAuthSubject :one
INSERT INTO oauth_subjects (workspace_id, user_id, subject)
VALUES (sqlc.arg('workspace_id'), sqlc.arg('user_id'), sqlc.arg('subject'))
RETURNING *;

-- name: GetOAuthSubject :one
SELECT * FROM oauth_subjects WHERE workspace_id = sqlc.arg('workspace_id') AND user_id = sqlc.arg('user_id');

-- name: CreateOAuthConsent :one
INSERT INTO oauth_consents (workspace_id, user_id, client_id, scopes, refresh_allowed)
VALUES (sqlc.arg('workspace_id'), sqlc.arg('user_id'), sqlc.arg('client_id'), sqlc.arg('scopes'), sqlc.arg('refresh_allowed'))
RETURNING *;

-- name: GetOAuthConsent :one
SELECT * FROM oauth_consents WHERE workspace_id = sqlc.arg('workspace_id') AND id = sqlc.arg('id');

-- name: CreateOAuthRequest :one
INSERT INTO oauth_authorization_requests (workspace_id, client_id, client_version, handle_hash, browser_hash, csrf_hash, session_id, user_id, redirect_uri, scopes, state, nonce, pkce_challenge, prompt, max_age_seconds, expires_at, issuer)
VALUES (sqlc.arg('workspace_id'), sqlc.arg('client_id'), sqlc.arg('client_version'), sqlc.arg('handle_hash'), sqlc.arg('browser_hash'), sqlc.narg('csrf_hash'), sqlc.narg('session_id'), sqlc.narg('user_id'), sqlc.arg('redirect_uri'), sqlc.arg('scopes'), sqlc.arg('state'), sqlc.arg('nonce'), sqlc.arg('pkce_challenge'), sqlc.arg('prompt'), sqlc.narg('max_age_seconds'), sqlc.arg('expires_at'), sqlc.arg('issuer'))
RETURNING *;

-- name: GetOAuthRequest :one
SELECT * FROM oauth_authorization_requests WHERE workspace_id = sqlc.arg('workspace_id') AND id = sqlc.arg('id');

-- name: CreateOAuthGrant :one
INSERT INTO oauth_grants (workspace_id, user_id, client_id, consent_id, session_id, scopes, client_version, consent_version, policy_version, access_version, session_version, authenticated_at, assurance_expires_at, expires_at, idle_expires_at, entitlement_version, issuer)
VALUES (sqlc.arg('workspace_id'), sqlc.arg('user_id'), sqlc.arg('client_id'), sqlc.arg('consent_id'), sqlc.arg('session_id'), sqlc.arg('scopes'), sqlc.arg('client_version'), sqlc.arg('consent_version'), sqlc.arg('policy_version'), sqlc.arg('access_version'), sqlc.arg('session_version'), sqlc.arg('authenticated_at'), sqlc.narg('assurance_expires_at'), sqlc.arg('expires_at'), sqlc.arg('idle_expires_at'), sqlc.arg('entitlement_version'), sqlc.arg('issuer'))
RETURNING *;

-- name: GetOAuthGrant :one
SELECT * FROM oauth_grants WHERE workspace_id = sqlc.arg('workspace_id') AND id = sqlc.arg('id');

-- name: CreateOAuthCode :one
INSERT INTO oauth_authorization_codes (workspace_id, grant_id, user_id, client_id, code_hash, redirect_uri, pkce_challenge, nonce, expires_at)
VALUES (sqlc.arg('workspace_id'), sqlc.arg('grant_id'), sqlc.arg('user_id'), sqlc.arg('client_id'), sqlc.arg('code_hash'), sqlc.arg('redirect_uri'), sqlc.arg('pkce_challenge'), sqlc.arg('nonce'), sqlc.arg('expires_at'))
RETURNING *;

-- name: GetOAuthCode :one
SELECT * FROM oauth_authorization_codes WHERE workspace_id = sqlc.arg('workspace_id') AND id = sqlc.arg('id');

-- name: CreateOAuthToken :one
INSERT INTO oauth_tokens (workspace_id, grant_id, user_id, client_id, token_hash, token_type, parent_token_id, expires_at, generation)
VALUES (sqlc.arg('workspace_id'), sqlc.arg('grant_id'), sqlc.arg('user_id'), sqlc.arg('client_id'), sqlc.arg('token_hash'), sqlc.arg('token_type'), sqlc.narg('parent_token_id'), sqlc.arg('expires_at'), sqlc.arg('generation'))
RETURNING *;

-- name: GetOAuthToken :one
SELECT * FROM oauth_tokens WHERE workspace_id = sqlc.arg('workspace_id') AND id = sqlc.arg('id');

-- name: FindOAuthClient :one
SELECT * FROM oauth_clients WHERE workspace_id=$1 AND client_id=$2;

-- name: GetOAuthClientForUpdate :one
SELECT * FROM oauth_clients WHERE workspace_id=$1 AND id=$2 FOR UPDATE;

-- name: ListOAuthClients :many
SELECT * FROM oauth_clients WHERE workspace_id=$1 ORDER BY created_at;

-- name: ListOAuthClientRedirects :many
SELECT * FROM oauth_client_redirects WHERE workspace_id=$1 AND client_id=$2 ORDER BY redirect_uri;

-- name: DeleteOAuthClientRedirects :execrows
DELETE FROM oauth_client_redirects WHERE workspace_id=$1 AND client_id=$2;

-- name: ListOAuthClientSecrets :many
SELECT * FROM oauth_client_secrets WHERE workspace_id=$1 AND client_id=$2 AND revoked_at IS NULL AND valid_until>now() ORDER BY created_at DESC;

-- name: RevokeOAuthClientSecrets :execrows
UPDATE oauth_client_secrets SET revoked_at=now() WHERE workspace_id=$1 AND client_id=$2 AND revoked_at IS NULL;

-- name: ExpireOAuthClientSecrets :execrows
UPDATE oauth_client_secrets SET valid_until=LEAST(valid_until,$3) WHERE workspace_id=$1 AND client_id=$2 AND revoked_at IS NULL;

-- name: UpdateOAuthClient :one
UPDATE oauth_clients SET name=sqlc.arg('name'),scopes=sqlc.arg('scopes'),refresh_enabled=sqlc.arg('refresh_enabled'),
allowed_origins=sqlc.arg('allowed_origins'),version=version+1
WHERE workspace_id=sqlc.arg('workspace_id') AND id=sqlc.arg('id') AND version=sqlc.arg('expected_version') RETURNING *;

-- name: DisableOAuthClient :one
UPDATE oauth_clients SET disabled_at=now(),version=version+1 WHERE workspace_id=$1 AND id=$2 RETURNING *;

-- name: UpsertOAuthSubject :one
INSERT INTO oauth_subjects(workspace_id,user_id,subject) VALUES($1,$2,$3)
ON CONFLICT(workspace_id,user_id) DO UPDATE SET subject=oauth_subjects.subject RETURNING *;

-- name: FindOAuthConsent :one
SELECT * FROM oauth_consents WHERE workspace_id=$1 AND user_id=$2 AND client_id=$3;

-- name: UpsertOAuthConsent :one
INSERT INTO oauth_consents(workspace_id,user_id,client_id,scopes,refresh_allowed) VALUES($1,$2,$3,$4,$5)
ON CONFLICT(workspace_id,user_id,client_id) DO UPDATE SET scopes=EXCLUDED.scopes,refresh_allowed=EXCLUDED.refresh_allowed,
version=oauth_consents.version+1,granted_at=now(),revoked_at=NULL RETURNING *;

-- name: RevokeOAuthConsent :one
UPDATE oauth_consents SET revoked_at=now(),version=version+1 WHERE workspace_id=$1 AND user_id=$2 AND client_id=$3 RETURNING *;

-- name: FindOAuthRequest :one
SELECT * FROM oauth_authorization_requests WHERE handle_hash=$1 AND browser_hash=$2;

-- name: BindOAuthRequest :one
UPDATE oauth_authorization_requests SET session_id=$3,user_id=$4,csrf_hash=$5
WHERE id=$1 AND browser_hash=$2 AND session_id IS NULL AND consumed_at IS NULL AND expires_at>now() RETURNING *;

-- name: ConsumeOAuthRequest :one
UPDATE oauth_authorization_requests SET consumed_at=now()
WHERE id=$1 AND browser_hash=$2 AND csrf_hash=$3 AND session_id=$4 AND user_id=$5
AND consumed_at IS NULL AND expires_at>now() RETURNING *;

-- name: GetOAuthGrantForUpdate :one
SELECT * FROM oauth_grants WHERE workspace_id=$1 AND id=$2 AND client_id=$3 FOR UPDATE;

-- name: ConsumeOAuthCode :one
UPDATE oauth_authorization_codes AS c SET consumed_at=now()
WHERE c.workspace_id=$1 AND c.client_id=$2 AND c.code_hash=$3 AND c.redirect_uri=$4 AND c.pkce_challenge=$5
AND c.consumed_at IS NULL AND c.expires_at>now()
AND EXISTS(SELECT FROM oauth_grants g WHERE g.id=c.grant_id AND g.revoked_at IS NULL AND g.expires_at>now() AND g.idle_expires_at>now())
RETURNING *;

-- name: FindOAuthToken :one
SELECT * FROM oauth_tokens WHERE workspace_id=$1 AND token_hash=$2 AND token_type=$3;

-- name: GetOAuthTokenForUpdate :one
SELECT * FROM oauth_tokens WHERE workspace_id=$1 AND client_id=$2 AND token_hash=$3 AND token_type=$4 FOR UPDATE;

-- name: ConsumeOAuthRefresh :one
UPDATE oauth_tokens AS t SET used_at=now() WHERE t.workspace_id=$1 AND t.client_id=$2 AND t.token_hash=$3 AND t.token_type='refresh'
AND t.used_at IS NULL AND t.revoked_at IS NULL AND t.expires_at>now()
AND EXISTS(SELECT FROM oauth_grants g WHERE g.id=t.grant_id AND g.revoked_at IS NULL AND g.expires_at>now() AND g.idle_expires_at>now())
RETURNING *;

-- name: TouchOAuthGrant :one
UPDATE oauth_grants SET idle_expires_at=LEAST(expires_at,now()+interval '30 minutes')
WHERE workspace_id=$1 AND id=$2 AND client_id=$3 AND revoked_at IS NULL AND expires_at>now() AND idle_expires_at>now() RETURNING *;

-- name: RevokeOAuthGrantForReplay :one
UPDATE oauth_grants g SET revoked_at=now(),revoked_reason='refresh_reuse'
WHERE g.workspace_id=$1 AND g.client_id=$2 AND g.revoked_at IS NULL
AND EXISTS(SELECT FROM oauth_tokens t WHERE t.grant_id=g.id AND t.client_id=$2 AND t.token_hash=$3 AND t.token_type='refresh' AND t.used_at IS NOT NULL)
RETURNING g.*;

-- name: RevokeOAuthGrant :execrows
UPDATE oauth_grants SET revoked_at=now(),revoked_reason=$4 WHERE workspace_id=$1 AND id=$2 AND user_id=$3 AND revoked_at IS NULL;

-- name: RevokeWorkspaceOAuthGrants :execrows
UPDATE oauth_grants SET revoked_at=now(),revoked_reason=sqlc.arg('reason')
WHERE workspace_id=sqlc.arg('workspace_id') AND revoked_at IS NULL
AND (sqlc.narg('user_id')::uuid IS NULL OR user_id=sqlc.narg('user_id'))
AND (sqlc.narg('session_id')::uuid IS NULL OR session_id=sqlc.narg('session_id'))
AND (sqlc.narg('client_id')::uuid IS NULL OR client_id=sqlc.narg('client_id'));

-- name: ListUserOAuthGrants :many
SELECT * FROM oauth_grants WHERE user_id=$1 AND (sqlc.narg('workspace_id')::uuid IS NULL OR workspace_id=sqlc.narg('workspace_id')) ORDER BY created_at DESC;
