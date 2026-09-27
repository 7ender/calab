-- Custom workspace roles (ADR-0026).
--
-- workspace_roles: every workspace has four built-in roles (builtin owner|admin|member|guest)
--   and up to 46 custom ones (builtin NULL). position: higher = more senior; built-ins sit at
--   fixed positions (guest 0, member 1, admin 1000, owner 1001), custom roles in between.
--   permissions: workspace-level bits; a member's are the OR over their roles.
-- member_roles: the roles of each member. The built-in ones follow workspace_members.role
--   (kept as the highest built-in role for older clients) through a trigger: owner → owner +
--   member, admin → admin + member, member → member, guest → guest. Custom roles are
--   assigned by the API.
-- room_permissions: role targets hold the role id (uuid text) instead of the role name.
--
-- Down converts built-in role targets back to names and drops the overrides of custom roles
-- (and edits of the built-in roles' permissions): lossy by design.

-- +goose Up
CREATE TABLE workspace_roles (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 32),
    color        integer NOT NULL DEFAULT 0 CHECK (color BETWEEN 0 AND 16777215),
    position     integer NOT NULL CHECK (position >= 0),
    permissions  bigint NOT NULL DEFAULT 0,
    builtin      text CHECK (builtin IN ('owner', 'admin', 'member', 'guest')),
    mentionable  boolean NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT workspace_roles_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT workspace_roles_builtin_key UNIQUE (workspace_id, builtin),
    -- Deferred: reordering renumbers several rows in one statement / transaction.
    CONSTRAINT workspace_roles_position_key UNIQUE (workspace_id, position) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE member_roles (
    workspace_id uuid NOT NULL,
    user_id      uuid NOT NULL,
    role_id      uuid NOT NULL,
    PRIMARY KEY (workspace_id, user_id, role_id),
    FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_members (workspace_id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, role_id) REFERENCES workspace_roles (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX member_roles_role_idx ON member_roles (workspace_id, role_id);

-- Built-in permission sets: perm.RoleDefaults (Go) / ROLE_DEFAULTS (TS). owner, admin:
-- ADMINISTRATOR (1024); member: VIEW_ROOM | SEND_MESSAGES | ATTACH_FILES | CONNECT | SPEAK |
-- STREAM | VIDEO (16503); guest: CONNECT | SPEAK (48).
-- +goose StatementBegin
CREATE FUNCTION workspace_builtin_roles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO workspace_roles (workspace_id, name, position, permissions, builtin) VALUES
        (NEW.id, 'owner', 1001, 1024, 'owner'),
        (NEW.id, 'admin', 1000, 1024, 'admin'),
        (NEW.id, 'member', 1, 16503, 'member'),
        (NEW.id, 'guest', 0, 48, 'guest');
    RETURN NULL;
END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION member_builtin_roles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.role = NEW.role THEN
            RETURN NULL;
        END IF;
        DELETE FROM member_roles mr USING workspace_roles wr
        WHERE mr.workspace_id = NEW.workspace_id AND mr.user_id = NEW.user_id
          AND wr.id = mr.role_id AND wr.builtin IS NOT NULL;
    END IF;
    INSERT INTO member_roles (workspace_id, user_id, role_id)
    SELECT NEW.workspace_id, NEW.user_id, wr.id FROM workspace_roles wr
    WHERE wr.workspace_id = NEW.workspace_id
      AND wr.builtin = ANY (CASE NEW.role WHEN 'owner' THEN ARRAY['owner', 'member']
                                          WHEN 'admin' THEN ARRAY['admin', 'member']
                                          ELSE ARRAY[NEW.role] END)
    ON CONFLICT DO NOTHING;
    RETURN NULL;
END
$$;
-- +goose StatementEnd

-- Existing workspaces and members.
INSERT INTO workspace_roles (workspace_id, name, position, permissions, builtin, created_at)
SELECT w.id, b.name, b.position, b.permissions, b.name, w.created_at
FROM workspaces w
CROSS JOIN (VALUES ('owner', 1001, 1024::bigint), ('admin', 1000, 1024::bigint),
                   ('member', 1, 16503::bigint), ('guest', 0, 48::bigint)) AS b (name, position, permissions);

INSERT INTO member_roles (workspace_id, user_id, role_id)
SELECT m.workspace_id, m.user_id, wr.id
FROM workspace_members m
JOIN workspace_roles wr ON wr.workspace_id = m.workspace_id
 AND wr.builtin = ANY (CASE m.role WHEN 'owner' THEN ARRAY['owner', 'member']
                                   WHEN 'admin' THEN ARRAY['admin', 'member']
                                   ELSE ARRAY[m.role] END);

-- Role targets: name → id of the workspace's built-in role; unknown names cannot match.
UPDATE room_permissions rp SET target_id = wr.id::text
FROM rooms r, workspace_roles wr
WHERE rp.target_type = 'role' AND r.id = rp.room_id
  AND wr.workspace_id = r.workspace_id AND wr.builtin = rp.target_id;
DELETE FROM room_permissions WHERE target_type = 'role' AND target_id IN ('owner', 'admin', 'member', 'guest');

CREATE TRIGGER workspaces_builtin_roles AFTER INSERT ON workspaces
    FOR EACH ROW EXECUTE FUNCTION workspace_builtin_roles();
CREATE TRIGGER workspace_members_builtin_roles AFTER INSERT OR UPDATE OF role ON workspace_members
    FOR EACH ROW EXECUTE FUNCTION member_builtin_roles();

-- +goose Down
DROP TRIGGER workspace_members_builtin_roles ON workspace_members;
DROP TRIGGER workspaces_builtin_roles ON workspaces;
DROP FUNCTION member_builtin_roles();
DROP FUNCTION workspace_builtin_roles();

UPDATE room_permissions rp SET target_id = wr.builtin
FROM workspace_roles wr
WHERE rp.target_type = 'role' AND rp.target_id = wr.id::text AND wr.builtin IS NOT NULL;
DELETE FROM room_permissions WHERE target_type = 'role' AND target_id NOT IN ('owner', 'admin', 'member', 'guest');

DROP TABLE member_roles;
DROP TABLE workspace_roles;
