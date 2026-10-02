-- ADR-0057: global read-only stickers, no workspace storage or plan quota.
-- +goose Up
ALTER TABLE sticker_packs ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE stickers ALTER COLUMN file_id DROP NOT NULL;
ALTER TABLE sticker_packs ADD CONSTRAINT builtin_pack_scope CHECK (
    (id = '5a976390-e511-5ebf-8e74-3e214d88c7c0' AND workspace_id IS NULL AND created_by IS NULL)
    OR (id <> '5a976390-e511-5ebf-8e74-3e214d88c7c0' AND workspace_id IS NOT NULL)
);
ALTER TABLE stickers ADD CONSTRAINT builtin_sticker_scope CHECK (
    (pack_id = '5a976390-e511-5ebf-8e74-3e214d88c7c0' AND file_id IS NULL AND id IN ('1b2b7d35-8800-5fee-9ed7-33672e202bdd', 'db43a172-3c58-5868-accc-0634b3e7062c', '82e01364-0323-5695-99ac-b048f74dea8a', '458b51d4-a6ad-5fb8-aa80-38e0f65bb44c', 'ffb51945-32df-5d11-a742-2f9399786d61', 'bbc7eeba-1a29-50ae-8cb6-312cd6710ee1', 'e294af4c-b858-553b-a4e7-3f8c6dd662bc', '12c1f7c5-d7b5-56b6-ae29-e32db1220093', '3440a6d3-800a-5a0c-8743-7570a36c0c58', '60551597-6f32-58e1-985d-e842d7853a9b', 'e2ef9c8f-60b0-555f-abb5-62398d264a85', '6485bd07-41e3-503d-8635-d804c961f7e8', 'e2c4ff0d-30c2-59ce-9532-fb9af385c45e', '88147f7b-3b2a-55a9-9201-77f8686b9791', '250a5d8e-150c-52ec-b4bb-59d60c70c5d1', '8bbe1f6a-7e1a-585e-ba88-b7378ff917bf'))
    OR (pack_id <> '5a976390-e511-5ebf-8e74-3e214d88c7c0' AND file_id IS NOT NULL AND id NOT IN ('1b2b7d35-8800-5fee-9ed7-33672e202bdd', 'db43a172-3c58-5868-accc-0634b3e7062c', '82e01364-0323-5695-99ac-b048f74dea8a', '458b51d4-a6ad-5fb8-aa80-38e0f65bb44c', 'ffb51945-32df-5d11-a742-2f9399786d61', 'bbc7eeba-1a29-50ae-8cb6-312cd6710ee1', 'e294af4c-b858-553b-a4e7-3f8c6dd662bc', '12c1f7c5-d7b5-56b6-ae29-e32db1220093', '3440a6d3-800a-5a0c-8743-7570a36c0c58', '60551597-6f32-58e1-985d-e842d7853a9b', 'e2ef9c8f-60b0-555f-abb5-62398d264a85', '6485bd07-41e3-503d-8635-d804c961f7e8', 'e2c4ff0d-30c2-59ce-9532-fb9af385c45e', '88147f7b-3b2a-55a9-9201-77f8686b9791', '250a5d8e-150c-52ec-b4bb-59d60c70c5d1', '8bbe1f6a-7e1a-585e-ba88-b7378ff917bf'))
);
INSERT INTO sticker_packs (id, name, short_name) VALUES ('5a976390-e511-5ebf-8e74-3e214d88c7c0', 'Calab Stikers', 'calab_stikers');
INSERT INTO stickers (id, pack_id, emoji, position, width, height) VALUES
('1b2b7d35-8800-5fee-9ed7-33672e202bdd', '5a976390-e511-5ebf-8e74-3e214d88c7c0', '😀', 0, 512, 512),
('db43a172-3c58-5868-accc-0634b3e7062c', '5a976390-e511-5ebf-8e74-3e214d88c7c0', '😂', 1, 512, 512),
('82e01364-0323-5695-99ac-b048f74dea8a', '5a976390-e511-5ebf-8e74-3e214d88c7c0', '😍', 2, 512, 512),
('458b51d4-a6ad-5fb8-aa80-38e0f65bb44c', '5a976390-e511-5ebf-8e74-3e214d88c7c0', '😉', 3, 512, 512),
('ffb51945-32df-5d11-a742-2f9399786d61', '5a976390-e511-5ebf-8e74-3e214d88c7c0', '🤩', 4, 512, 512),
('bbc7eeba-1a29-50ae-8cb6-312cd6710ee1', '5a976390-e511-5ebf-8e74-3e214d88c7c0', '😢', 5, 512, 512),
('e294af4c-b858-553b-a4e7-3f8c6dd662bc', '5a976390-e511-5ebf-8e74-3e214d88c7c0', '😤', 6, 512, 512),
('12c1f7c5-d7b5-56b6-ae29-e32db1220093', '5a976390-e511-5ebf-8e74-3e214d88c7c0', '😮', 7, 512, 512),
('3440a6d3-800a-5a0c-8743-7570a36c0c58', '5a976390-e511-5ebf-8e74-3e214d88c7c0', '🤔', 8, 512, 512),
('60551597-6f32-58e1-985d-e842d7853a9b', '5a976390-e511-5ebf-8e74-3e214d88c7c0', '😅', 9, 512, 512),
('e2ef9c8f-60b0-555f-abb5-62398d264a85', '5a976390-e511-5ebf-8e74-3e214d88c7c0', '😴', 10, 512, 512),
('6485bd07-41e3-503d-8635-d804c961f7e8', '5a976390-e511-5ebf-8e74-3e214d88c7c0', '😎', 11, 512, 512),
('e2c4ff0d-30c2-59ce-9532-fb9af385c45e', '5a976390-e511-5ebf-8e74-3e214d88c7c0', '👍', 12, 512, 512),
('88147f7b-3b2a-55a9-9201-77f8686b9791', '5a976390-e511-5ebf-8e74-3e214d88c7c0', '👏', 13, 512, 512),
('250a5d8e-150c-52ec-b4bb-59d60c70c5d1', '5a976390-e511-5ebf-8e74-3e214d88c7c0', '🙏', 14, 512, 512),
('8bbe1f6a-7e1a-585e-ba88-b7378ff917bf', '5a976390-e511-5ebf-8e74-3e214d88c7c0', '🔥', 15, 512, 512);
UPDATE sticker_packs SET cover_sticker_id = '1b2b7d35-8800-5fee-9ed7-33672e202bdd' WHERE id = '5a976390-e511-5ebf-8e74-3e214d88c7c0';

-- +goose Down
-- Refuse rollback once messages use this pack; never silently erase sticker history.
-- +goose StatementBegin
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM messages WHERE sticker_id IN ('1b2b7d35-8800-5fee-9ed7-33672e202bdd', 'db43a172-3c58-5868-accc-0634b3e7062c', '82e01364-0323-5695-99ac-b048f74dea8a', '458b51d4-a6ad-5fb8-aa80-38e0f65bb44c', 'ffb51945-32df-5d11-a742-2f9399786d61', 'bbc7eeba-1a29-50ae-8cb6-312cd6710ee1', 'e294af4c-b858-553b-a4e7-3f8c6dd662bc', '12c1f7c5-d7b5-56b6-ae29-e32db1220093', '3440a6d3-800a-5a0c-8743-7570a36c0c58', '60551597-6f32-58e1-985d-e842d7853a9b', 'e2ef9c8f-60b0-555f-abb5-62398d264a85', '6485bd07-41e3-503d-8635-d804c961f7e8', 'e2c4ff0d-30c2-59ce-9532-fb9af385c45e', '88147f7b-3b2a-55a9-9201-77f8686b9791', '250a5d8e-150c-52ec-b4bb-59d60c70c5d1', '8bbe1f6a-7e1a-585e-ba88-b7378ff917bf')) THEN
        RAISE EXCEPTION 'Cannot remove built-in stickers referenced by messages';
    END IF;
END $$;
-- +goose StatementEnd
DELETE FROM sticker_packs WHERE id = '5a976390-e511-5ebf-8e74-3e214d88c7c0';
ALTER TABLE stickers DROP CONSTRAINT builtin_sticker_scope;
ALTER TABLE sticker_packs DROP CONSTRAINT builtin_pack_scope;
ALTER TABLE stickers ALTER COLUMN file_id SET NOT NULL;
ALTER TABLE sticker_packs ALTER COLUMN workspace_id SET NOT NULL;
