-- Identity v1 foundation, ADR-0054. Consumer mutations run with audit/outbox in one transaction.

-- name: CreateIdentityDirectory :one
INSERT INTO workspace_directories (id, workspace_id, name, host, url, allowed_group_dns, port, base_dn, bind_dn, bind_secret_box, ca_pem, sync_interval_seconds, max_staleness_seconds)
VALUES (COALESCE(sqlc.narg('id')::uuid, uuidv7()), sqlc.arg('workspace_id'), sqlc.arg('name'), sqlc.arg('host'), sqlc.arg('url'), sqlc.arg('allowed_group_dns'), sqlc.arg('port'), sqlc.arg('base_dn'), sqlc.arg('bind_dn'), sqlc.arg('bind_secret_box'), sqlc.arg('ca_pem'), sqlc.arg('sync_interval_seconds'), sqlc.arg('max_staleness_seconds'))
RETURNING *;

-- name: GetIdentityDirectory :one
SELECT * FROM workspace_directories WHERE workspace_id = sqlc.arg('workspace_id') AND id = sqlc.arg('id');

-- name: CreateDirectorySyncRun :one
INSERT INTO directory_sync_runs (workspace_id, directory_id, full_scan, config_version, lease_until, status, complete, objects_seen, started_at, generation)
VALUES (sqlc.arg('workspace_id'), sqlc.arg('directory_id'), sqlc.arg('full_scan'), sqlc.arg('config_version'), sqlc.arg('lease_until'), sqlc.arg('status'), sqlc.arg('complete'), sqlc.arg('objects_seen'), sqlc.arg('started_at'), sqlc.arg('generation'))
RETURNING *;

-- name: GetDirectorySyncRun :one
SELECT * FROM directory_sync_runs WHERE workspace_id = sqlc.arg('workspace_id') AND id = sqlc.arg('id');

-- name: CreateDirectoryObject :one
INSERT INTO directory_objects (workspace_id, directory_id, object_guid, user_id, distinguished_name, status)
VALUES (sqlc.arg('workspace_id'), sqlc.arg('directory_id'), sqlc.arg('object_guid'), sqlc.narg('user_id'), sqlc.arg('distinguished_name'), sqlc.arg('status'))
RETURNING *;

-- name: GetDirectoryObject :one
SELECT * FROM directory_objects WHERE workspace_id = sqlc.arg('workspace_id') AND id = sqlc.arg('id');

-- name: CreateDirectorySyncObject :one
INSERT INTO directory_sync_objects (workspace_id, directory_id, run_id, object_guid, distinguished_name, eligible, disabled)
VALUES (sqlc.arg('workspace_id'), sqlc.arg('directory_id'), sqlc.arg('run_id'), sqlc.arg('object_guid'), sqlc.arg('distinguished_name'), sqlc.arg('eligible'), sqlc.arg('disabled'))
RETURNING *;

-- name: GetDirectorySyncObject :one
SELECT * FROM directory_sync_objects WHERE run_id = sqlc.arg('run_id') AND object_guid = sqlc.arg('object_guid');

-- name: GetWorkspaceIdentityDirectory :one
SELECT * FROM workspace_directories WHERE workspace_id=$1;

-- name: GetIdentityDirectoryForUpdate :one
SELECT * FROM workspace_directories WHERE workspace_id=$1 FOR UPDATE;

-- name: ListEnabledIdentityDirectories :many
SELECT * FROM workspace_directories WHERE disabled_at IS NULL ORDER BY id LIMIT $1;

-- name: UpdateIdentityDirectory :one
UPDATE workspace_directories SET name=sqlc.arg('name'),host=sqlc.arg('host'),url=sqlc.arg('url'),
base_dn=sqlc.arg('base_dn'),bind_dn=sqlc.arg('bind_dn'),bind_secret_box=sqlc.arg('bind_secret_box'),
allowed_group_dns=sqlc.arg('allowed_group_dns'),ca_pem=sqlc.arg('ca_pem'),version=version+1,
sync_interval_seconds=sqlc.arg('sync_interval_seconds'),max_staleness_seconds=sqlc.arg('max_staleness_seconds'),
disabled_at=sqlc.narg('disabled_at')
WHERE workspace_id=sqlc.arg('workspace_id') AND version=sqlc.arg('expected_version') RETURNING *;

-- name: ListDirectoryObjects :many
SELECT * FROM directory_objects WHERE workspace_id=$1 AND (sqlc.narg('after_id')::uuid IS NULL OR id>sqlc.narg('after_id')) ORDER BY id LIMIT sqlc.arg('limit_count');

-- name: FindDirectoryObjectGUID :one
SELECT * FROM directory_objects WHERE workspace_id=$1 AND directory_id=$2 AND object_guid=$3;

-- name: SetDirectoryObjectStatus :one
UPDATE directory_objects SET status=$3,version=version+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 RETURNING *;

-- name: SetDirectoryObjectUser :one
UPDATE directory_objects SET user_id=$3,version=version+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 RETURNING *;

-- name: ListDirectorySyncObjects :many
SELECT * FROM directory_sync_objects WHERE run_id=$1 ORDER BY object_guid;

-- name: FinishDirectorySyncRun :one
UPDATE directory_sync_runs SET status=$2,complete=$3,objects_seen=$4,finished_at=clock_timestamp()
WHERE id=$1 AND status='running' RETURNING *;

-- name: PublishDirectorySuccess :one
UPDATE workspace_directories d SET last_success_at=clock_timestamp(),generation=sqlc.arg('generation'),cursor_box=sqlc.narg('cursor_box'),last_error=''
WHERE d.workspace_id=sqlc.arg('workspace_id') AND d.id=sqlc.arg('directory_id') AND d.version=sqlc.arg('config_version')
AND EXISTS(SELECT FROM directory_sync_runs r WHERE r.id=sqlc.arg('run_id') AND r.directory_id=d.id AND r.config_version=d.version
AND r.status='succeeded' AND r.complete AND r.full_scan AND r.generation=sqlc.arg('generation') AND r.generation>d.generation)
RETURNING d.*;

-- name: SetDirectoryError :exec
UPDATE workspace_directories SET last_error=$3 WHERE workspace_id=$1 AND id=$2;

-- name: UpdateDirectoryObjectSnapshot :one
UPDATE directory_objects SET distinguished_name=sqlc.arg('distinguished_name'),status=sqlc.arg('status'),
last_seen_run_id=sqlc.narg('last_seen_run_id'),missing_full_scans=sqlc.arg('missing_full_scans'),
version=version+1,updated_at=clock_timestamp()
WHERE workspace_id=sqlc.arg('workspace_id') AND directory_id=sqlc.arg('directory_id') AND id=sqlc.arg('id')
AND version=sqlc.arg('expected_version') RETURNING *;

-- name: ListEnabledIdentityDirectoriesAfter :many
SELECT * FROM workspace_directories WHERE disabled_at IS NULL
AND (sqlc.narg('after_id')::uuid IS NULL OR id>sqlc.narg('after_id'))
ORDER BY id LIMIT sqlc.arg('limit_count');
