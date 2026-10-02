-- Identity v1 foundation, ADR-0054. Consumer mutations run with audit/outbox in one transaction.

-- name: CreateOAuthClient :one
INSERT INTO oauth_clients (workspace_id, client_id, name, client_type, refresh_enabled, allowed_origins, auth_method, scopes, created_by)
VALUES (sqlc.arg('workspace_id'), sqlc.arg('client_id'), sqlc.arg('name'), sqlc.arg('client_type'), sqlc.arg('refresh_enabled'), sqlc.arg('allowed_origins'), sqlc.arg('auth_method'), sqlc.arg('scopes'), sqlc.narg('created_by'))
RETURNING *;

-- name: RevokeOAuthSessionGrants :execrows
UPDATE oauth_grants SET revoked_at=clock_timestamp(),revoked_reason=sqlc.arg('reason')
WHERE session_id=sqlc.arg('session_id') AND revoked_at IS NULL;

-- name: NarrowOAuthGrantScopes :one
UPDATE oauth_grants SET scopes=sqlc.arg('scopes')
WHERE workspace_id=sqlc.arg('workspace_id') AND id=sqlc.arg('id') AND client_id=sqlc.arg('client_id')
AND sqlc.arg('scopes')::text[] <@ scopes AND 'openid'=ANY(sqlc.arg('scopes')::text[])
AND revoked_at IS NULL AND expires_at>clock_timestamp() AND idle_expires_at>clock_timestamp()
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
INSERT INTO oauth_authorization_requests (workspace_id, client_id, client_version, handle_hash, browser_hash, csrf_hash, session_id, user_id, redirect_uri, scopes, state, nonce, pkce_challenge, prompt, max_age_seconds, expires_at, issuer, client_ip_hash)
VALUES (sqlc.arg('workspace_id'), sqlc.arg('client_id'), sqlc.arg('client_version'), sqlc.arg('handle_hash'), sqlc.arg('browser_hash'), sqlc.narg('csrf_hash'), sqlc.narg('session_id'), sqlc.narg('user_id'), sqlc.arg('redirect_uri'), sqlc.arg('scopes'), sqlc.arg('state'), sqlc.arg('nonce'), sqlc.arg('pkce_challenge'), sqlc.arg('prompt'), sqlc.narg('max_age_seconds'), sqlc.arg('expires_at'), sqlc.arg('issuer'), sqlc.arg('client_ip_hash'))
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
SELECT * FROM oauth_client_secrets WHERE workspace_id=$1 AND client_id=$2 AND revoked_at IS NULL AND valid_until>clock_timestamp() ORDER BY created_at DESC;

-- name: RevokeOAuthClientSecrets :execrows
UPDATE oauth_client_secrets SET revoked_at=clock_timestamp() WHERE workspace_id=$1 AND client_id=$2 AND revoked_at IS NULL;

-- name: ExpireOAuthClientSecrets :execrows
UPDATE oauth_client_secrets SET valid_until=LEAST(valid_until,$3) WHERE workspace_id=$1 AND client_id=$2 AND revoked_at IS NULL;

-- name: UpdateOAuthClient :one
UPDATE oauth_clients SET name=sqlc.arg('name'),scopes=sqlc.arg('scopes'),refresh_enabled=sqlc.arg('refresh_enabled'),
allowed_origins=sqlc.arg('allowed_origins'),version=version+1
WHERE workspace_id=sqlc.arg('workspace_id') AND id=sqlc.arg('id') AND version=sqlc.arg('expected_version') RETURNING *;

-- name: DisableOAuthClient :one
UPDATE oauth_clients SET disabled_at=clock_timestamp(),version=version+1 WHERE workspace_id=$1 AND id=$2 RETURNING *;

-- name: UpsertOAuthSubject :one
INSERT INTO oauth_subjects(workspace_id,user_id,subject) VALUES($1,$2,$3)
ON CONFLICT(workspace_id,user_id) DO UPDATE SET subject=oauth_subjects.subject RETURNING *;

-- name: FindOAuthConsent :one
SELECT * FROM oauth_consents WHERE workspace_id=$1 AND user_id=$2 AND client_id=$3;

-- name: UpsertOAuthConsent :one
-- The version (pinned by every grant) moves only when the new decision is not a
-- superset of a live previous one: narrower scopes, a changed refresh decision or
-- a revoked consent invalidate all families; a widening keeps other devices' grants,
-- which stay bounded by their own scopes.
INSERT INTO oauth_consents(workspace_id,user_id,client_id,scopes,refresh_allowed,client_name) VALUES($1,$2,$3,$4,$5,$6)
ON CONFLICT(workspace_id,user_id,client_id) DO UPDATE SET scopes=EXCLUDED.scopes,refresh_allowed=EXCLUDED.refresh_allowed,
client_name=EXCLUDED.client_name,
version=oauth_consents.version+CASE WHEN oauth_consents.revoked_at IS NULL AND EXCLUDED.scopes @> oauth_consents.scopes
    AND EXCLUDED.refresh_allowed=oauth_consents.refresh_allowed THEN 0 ELSE 1 END,
granted_at=clock_timestamp(),revoked_at=NULL RETURNING *;

-- name: RevokeReplacedOAuthGrants :execrows
-- Re-consent replaces the family of this device (session) only; families pinned to an
-- older consent version are dead anyway and are closed here as well.
UPDATE oauth_grants SET revoked_at=clock_timestamp(),revoked_reason='consent_replaced'
WHERE workspace_id=sqlc.arg('workspace_id') AND user_id=sqlc.arg('user_id') AND client_id=sqlc.arg('client_id')
AND revoked_at IS NULL AND (session_id=sqlc.arg('session_id') OR consent_version<>sqlc.arg('consent_version'));

-- name: RevokeOAuthConsent :one
UPDATE oauth_consents SET revoked_at=clock_timestamp(),version=version+1 WHERE workspace_id=$1 AND user_id=$2 AND client_id=$3 RETURNING *;

-- name: FindOAuthRequest :one
SELECT * FROM oauth_authorization_requests WHERE handle_hash=$1 AND browser_hash=$2;

-- name: BindOAuthRequest :one
-- The same session may bind again (consent page reload after a rename): the csrf
-- rotates and the shown client name is replaced. Another account needs a new request.
WITH locked AS MATERIALIZED (
    SELECT src.* FROM oauth_authorization_requests AS src WHERE src.id=sqlc.arg('id') AND src.browser_hash=sqlc.arg('browser_hash') FOR UPDATE
), eligible AS MATERIALIZED (
    SELECT locked.id FROM locked WHERE (locked.session_id IS NULL OR (locked.session_id=sqlc.arg('session_id') AND locked.user_id=sqlc.arg('user_id')))
    AND locked.consumed_at IS NULL AND locked.expires_at>clock_timestamp()
)
UPDATE oauth_authorization_requests AS t SET session_id=sqlc.arg('session_id'),user_id=sqlc.arg('user_id'),csrf_hash=sqlc.arg('csrf_hash'),shown_client_name=sqlc.arg('shown_client_name')
FROM eligible WHERE t.id=eligible.id RETURNING t.*;

-- name: CountPendingOAuthRequestsByIP :one
-- Bounded count: stops scanning at the cap.
SELECT count(*) FROM (SELECT 1 FROM oauth_authorization_requests
WHERE client_ip_hash=sqlc.arg('client_ip_hash') AND consumed_at IS NULL AND expires_at>clock_timestamp()
LIMIT sqlc.arg('cap')::int) AS pending;

-- name: DeleteEvictedOAuthRequests :execrows
-- Requests whose browser binding fell out of the cookie can never be continued.
DELETE FROM oauth_authorization_requests WHERE browser_hash=ANY(sqlc.arg('browser_hashes')::bytea[]) AND consumed_at IS NULL;

-- name: ConsumeOAuthRequest :one
WITH locked AS MATERIALIZED (
    SELECT src.* FROM oauth_authorization_requests AS src WHERE src.id=$1 AND src.browser_hash=$2 AND src.csrf_hash=$3 AND src.session_id=$4 AND src.user_id=$5 FOR UPDATE
), eligible AS MATERIALIZED (
    SELECT locked.id FROM locked WHERE locked.consumed_at IS NULL AND locked.expires_at>clock_timestamp()
)
UPDATE oauth_authorization_requests AS t SET consumed_at=clock_timestamp()
FROM eligible WHERE t.id=eligible.id RETURNING t.*;

-- name: GetOAuthGrantForUpdate :one
SELECT * FROM oauth_grants WHERE workspace_id=$1 AND id=$2 AND client_id=$3 FOR UPDATE;

-- name: ConsumeOAuthCode :one
WITH locked AS MATERIALIZED (
    SELECT src.* FROM oauth_authorization_codes AS src WHERE src.workspace_id=$1 AND src.client_id=$2 AND src.code_hash=$3 AND src.redirect_uri=$4 AND src.pkce_challenge=$5 FOR UPDATE
), eligible AS MATERIALIZED (
    SELECT locked.id FROM locked WHERE locked.consumed_at IS NULL AND locked.expires_at>clock_timestamp() AND EXISTS(SELECT FROM oauth_grants g WHERE g.id=locked.grant_id AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND g.idle_expires_at>clock_timestamp())
)
UPDATE oauth_authorization_codes AS t SET consumed_at=clock_timestamp()
FROM eligible WHERE t.id=eligible.id RETURNING t.*;

-- name: FindOAuthToken :one
SELECT * FROM oauth_tokens WHERE workspace_id=$1 AND token_hash=$2 AND token_type=$3;

-- name: GetConsumedOAuthCodeForUpdate :one
SELECT * FROM oauth_authorization_codes
WHERE workspace_id=$1 AND client_id=$2 AND code_hash=$3 AND redirect_uri=$4 AND pkce_challenge=$5 AND consumed_at IS NOT NULL
FOR UPDATE;

-- name: GetOAuthTokenForUpdate :one
SELECT * FROM oauth_tokens WHERE workspace_id=$1 AND client_id=$2 AND token_hash=$3 AND token_type=$4 FOR UPDATE;

-- name: ConsumeOAuthRefresh :one
WITH locked AS MATERIALIZED (
    SELECT src.* FROM oauth_tokens AS src WHERE src.workspace_id=$1 AND src.client_id=$2 AND src.token_hash=$3 AND src.token_type='refresh' FOR UPDATE
), eligible AS MATERIALIZED (
    SELECT locked.id FROM locked WHERE locked.used_at IS NULL AND locked.revoked_at IS NULL AND locked.expires_at>clock_timestamp() AND EXISTS(SELECT FROM oauth_grants g WHERE g.id=locked.grant_id AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND g.idle_expires_at>clock_timestamp())
)
UPDATE oauth_tokens AS t SET used_at=clock_timestamp()
FROM eligible WHERE t.id=eligible.id RETURNING t.*;

-- name: TouchOAuthGrant :one
WITH locked AS MATERIALIZED (
    SELECT src.* FROM oauth_grants AS src WHERE src.workspace_id=$1 AND src.id=$2 AND src.client_id=$3 FOR UPDATE
), eligible AS MATERIALIZED (
    SELECT locked.id FROM locked WHERE locked.revoked_at IS NULL AND locked.expires_at>clock_timestamp() AND locked.idle_expires_at>clock_timestamp()
)
UPDATE oauth_grants AS t SET idle_expires_at=LEAST(t.expires_at,clock_timestamp()+interval '30 minutes')
FROM eligible WHERE t.id=eligible.id RETURNING t.*;

-- name: RevokeOAuthGrantForReplay :one
UPDATE oauth_grants g SET revoked_at=clock_timestamp(),revoked_reason='refresh_reuse'
WHERE g.workspace_id=$1 AND g.client_id=$2 AND g.revoked_at IS NULL
AND EXISTS(SELECT FROM oauth_tokens t WHERE t.grant_id=g.id AND t.client_id=$2 AND t.token_hash=$3 AND t.token_type='refresh' AND t.used_at IS NOT NULL)
RETURNING g.*;

-- name: RevokeOAuthGrant :execrows
UPDATE oauth_grants SET revoked_at=clock_timestamp(),revoked_reason=$4 WHERE workspace_id=$1 AND id=$2 AND user_id=$3 AND revoked_at IS NULL;

-- name: RevokeWorkspaceOAuthGrants :execrows
UPDATE oauth_grants SET revoked_at=clock_timestamp(),revoked_reason=sqlc.arg('reason')
WHERE workspace_id=sqlc.arg('workspace_id') AND revoked_at IS NULL
AND (sqlc.narg('user_id')::uuid IS NULL OR user_id=sqlc.narg('user_id'))
AND (sqlc.narg('session_id')::uuid IS NULL OR session_id=sqlc.narg('session_id'))
AND (sqlc.narg('client_id')::uuid IS NULL OR client_id=sqlc.narg('client_id'));

-- name: ListUserOAuthGrants :many
SELECT * FROM oauth_grants WHERE user_id=$1 AND (sqlc.narg('workspace_id')::uuid IS NULL OR workspace_id=sqlc.narg('workspace_id')) ORDER BY created_at DESC;
-- name: LockOAuthWorkspace :one
-- NO KEY UPDATE serializes identity writers and provider issuance without blocking
-- workspace-wide FK key-share inserts (messages, members, files) behind it.
SELECT * FROM workspaces WHERE id=$1 FOR NO KEY UPDATE;

-- name: UpdateOAuthClientName :one
UPDATE oauth_clients SET name=sqlc.arg('name')
WHERE workspace_id=sqlc.arg('workspace_id') AND id=sqlc.arg('id') AND version=sqlc.arg('expected_version')
RETURNING *;

-- name: FindOAuthCodeForClient :one
-- Unlocked pre-authentication lookup; the issuing transaction re-reads under lock.
SELECT * FROM oauth_authorization_codes
WHERE workspace_id=$1 AND client_id=$2 AND code_hash=$3 AND redirect_uri=$4 AND pkce_challenge=$5;

-- name: ListUserOAuthGrantsWithClient :many
SELECT g.id, g.workspace_id, c.name AS client_name, g.scopes, g.created_at, g.expires_at, g.revoked_at
FROM oauth_grants g JOIN oauth_clients c ON c.workspace_id=g.workspace_id AND c.id=g.client_id
WHERE g.user_id=$1 AND (sqlc.narg('workspace_id')::uuid IS NULL OR g.workspace_id=sqlc.narg('workspace_id'))
ORDER BY g.created_at DESC;

-- Retention (one sweeper per cluster). Each statement deletes at most a batch.

-- name: DeleteExpiredOAuthRequests :execrows
DELETE FROM oauth_authorization_requests WHERE id IN (
    SELECT id FROM oauth_authorization_requests WHERE expires_at < clock_timestamp() LIMIT sqlc.arg('batch')::int);

-- name: DeleteExpiredOAuthCodes :execrows
DELETE FROM oauth_authorization_codes WHERE id IN (
    SELECT id FROM oauth_authorization_codes WHERE expires_at < clock_timestamp() - make_interval(secs => sqlc.arg('window_seconds')::int) LIMIT sqlc.arg('batch')::int);

-- name: DeleteExpiredOAuthAccessTokens :execrows
-- Access tokens are never parents; refresh tokens leave with their grant (parent FK cascades).
DELETE FROM oauth_tokens WHERE id IN (
    SELECT id FROM oauth_tokens WHERE token_type='access' AND expires_at < clock_timestamp() - make_interval(secs => sqlc.arg('window_seconds')::int) LIMIT sqlc.arg('batch')::int);

-- name: DeleteFinishedOAuthGrants :execrows
-- Expired or revoked (incl. superseded by re-consent) grants after the replay window;
-- codes and tokens of the family cascade.
DELETE FROM oauth_grants WHERE id IN (
    SELECT id FROM oauth_grants WHERE expires_at < clock_timestamp() - make_interval(secs => sqlc.arg('window_seconds')::int)
    UNION
    SELECT id FROM oauth_grants WHERE revoked_at < clock_timestamp() - make_interval(secs => sqlc.arg('window_seconds')::int)
    LIMIT sqlc.arg('batch')::int);

-- name: GetOAuthTokenForClient :one
-- Unlocked pre-authentication lookup for revocation.
SELECT * FROM oauth_tokens WHERE workspace_id=$1 AND client_id=$2 AND token_hash=$3 AND token_type=$4;
