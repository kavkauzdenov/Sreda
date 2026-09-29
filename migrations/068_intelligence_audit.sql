CREATE TABLE intelligence_audit_log (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES business(id) ON DELETE CASCADE,
  user_id uuid REFERENCES "user"(id) ON DELETE SET NULL,
  operation text NOT NULL,
  source text NOT NULL DEFAULT 'business_brain',
  reason text,
  result text NOT NULL DEFAULT 'ok',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX intelligence_audit_log_business_created_idx
  ON intelligence_audit_log (business_id, created_at DESC);
