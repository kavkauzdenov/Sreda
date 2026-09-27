-- Clients V2: assignee, profile note, tags, duplicate decisions.
-- Additive only. No DROP of client data.

ALTER TABLE client
  ADD COLUMN IF NOT EXISTS assigned_user_id uuid,
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz,
  ADD COLUMN IF NOT EXISTS profile_note text;

ALTER TABLE client DROP CONSTRAINT IF EXISTS client_assigned_user_scope;
ALTER TABLE client
  ADD CONSTRAINT client_assigned_user_scope
  FOREIGN KEY (business_id, assigned_user_id)
  REFERENCES business_member (business_id, user_id);

ALTER TABLE client DROP CONSTRAINT IF EXISTS client_profile_note_len;
ALTER TABLE client
  ADD CONSTRAINT client_profile_note_len
  CHECK (profile_note IS NULL OR char_length(profile_note) <= 4000);

CREATE INDEX IF NOT EXISTS client_business_assigned_idx
  ON client (business_id, assigned_user_id)
  WHERE archived_at IS NULL AND assigned_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS client_tag (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES business (id),
  name text NOT NULL,
  name_normalized text NOT NULL,
  color_key text NOT NULL DEFAULT 'neutral',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, name_normalized),
  CHECK (char_length(name) BETWEEN 1 AND 40),
  CHECK (char_length(color_key) BETWEEN 1 AND 32)
);

CREATE TABLE IF NOT EXISTS client_tag_link (
  business_id uuid NOT NULL,
  client_id uuid NOT NULL,
  tag_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, client_id, tag_id),
  FOREIGN KEY (business_id, client_id)
    REFERENCES client (business_id, id),
  FOREIGN KEY (tag_id)
    REFERENCES client_tag (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS client_tag_link_tag_idx
  ON client_tag_link (business_id, tag_id);

CREATE TABLE IF NOT EXISTS client_duplicate_decision (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES business (id),
  client_a_id uuid NOT NULL,
  client_b_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('separate', 'merged')),
  actor_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (client_a_id < client_b_id),
  UNIQUE (business_id, client_a_id, client_b_id),
  FOREIGN KEY (business_id, client_a_id)
    REFERENCES client (business_id, id),
  FOREIGN KEY (business_id, client_b_id)
    REFERENCES client (business_id, id)
);

CREATE INDEX IF NOT EXISTS client_activity_timeline_idx
  ON client_activity (business_id, client_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS client_note_timeline_idx
  ON client_note (business_id, client_id, created_at DESC, id);
