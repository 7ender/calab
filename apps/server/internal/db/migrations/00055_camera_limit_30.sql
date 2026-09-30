-- Cameras in a voice room: the ceiling of camera_limit goes 25 -> 30 so the Business plan
-- (30 webcams, owner 30.09, ADR-0024) can be used in full. Only widens the CHECKs: every stored
-- value stays valid, so the new constraints are added NOT VALID and validated without a long lock.

-- +goose Up
ALTER TABLE workspaces DROP CONSTRAINT workspaces_default_camera_limit_check;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_default_camera_limit_check
    CHECK (default_camera_limit BETWEEN 0 AND 30) NOT VALID;
ALTER TABLE workspaces VALIDATE CONSTRAINT workspaces_default_camera_limit_check;
ALTER TABLE rooms DROP CONSTRAINT rooms_camera_limit_check;
ALTER TABLE rooms ADD CONSTRAINT rooms_camera_limit_check CHECK (camera_limit BETWEEN 0 AND 30) NOT VALID;
ALTER TABLE rooms VALIDATE CONSTRAINT rooms_camera_limit_check;

-- +goose Down
UPDATE workspaces SET default_camera_limit = 25 WHERE default_camera_limit > 25;
UPDATE rooms SET camera_limit = 25 WHERE camera_limit > 25;
ALTER TABLE workspaces DROP CONSTRAINT workspaces_default_camera_limit_check;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_default_camera_limit_check CHECK (default_camera_limit BETWEEN 0 AND 25);
ALTER TABLE rooms DROP CONSTRAINT rooms_camera_limit_check;
ALTER TABLE rooms ADD CONSTRAINT rooms_camera_limit_check CHECK (camera_limit BETWEEN 0 AND 25);
