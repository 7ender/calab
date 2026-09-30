-- Details of imported CalDAV events (ADR-0045).
--
-- external_busy    + summary, location (≤ 200 characters), attendees ([{email, name?}], ≤ 50,
--                  e-mails in lower case), organizer (e-mail), url (≤ 500: URL of the event or
--                  the first https:// link of its description). The description itself is
--                  never stored. Rows of before are filled by the next import (15 min).
-- caldav_accounts  + share_level: what colleagues see in free / busy — busy (default) · title
--                  · details (title and the attendees who are members of the workspace).

-- +goose Up
ALTER TABLE external_busy
    ADD COLUMN summary   text NOT NULL DEFAULT '' CHECK (char_length(summary) <= 200),
    ADD COLUMN location  text NOT NULL DEFAULT '' CHECK (char_length(location) <= 200),
    ADD COLUMN attendees jsonb NOT NULL DEFAULT '[]'
        CHECK (jsonb_typeof(attendees) = 'array' AND jsonb_array_length(attendees) <= 50),
    ADD COLUMN organizer text NOT NULL DEFAULT '' CHECK (char_length(organizer) <= 320),
    ADD COLUMN url       text NOT NULL DEFAULT '' CHECK (char_length(url) <= 500);

ALTER TABLE caldav_accounts
    ADD COLUMN share_level text NOT NULL DEFAULT 'busy' CHECK (share_level IN ('busy', 'title', 'details'));

-- +goose Down
ALTER TABLE caldav_accounts DROP COLUMN share_level;
ALTER TABLE external_busy DROP COLUMN summary, DROP COLUMN location, DROP COLUMN attendees,
    DROP COLUMN organizer, DROP COLUMN url;
