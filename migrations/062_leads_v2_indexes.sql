-- Leads V2: additive indexes for list/filter/CRM/history lookups.
-- No destructive changes. Safe on existing data.

CREATE INDEX IF NOT EXISTS lead_business_status_created_idx
  ON "lead" (business_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS lead_business_processing_status_idx
  ON "lead" (business_id, processing_by, status)
  WHERE processing_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS lead_business_client_created_idx
  ON "lead" (business_id, client_id, created_at DESC)
  WHERE client_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS lead_form_field_active_position_idx
  ON lead_form_field (business_id, active, position);
