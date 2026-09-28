CREATE TABLE IF NOT EXISTS platform_admin_mfa_session (
  session_id uuid PRIMARY KEY REFERENCES "session"(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  verified_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_admin_mfa_session_user_idx
  ON platform_admin_mfa_session (user_id, verified_at);
