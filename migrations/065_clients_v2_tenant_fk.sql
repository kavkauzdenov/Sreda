-- Clients V2 hardening: tenant-safe FKs for tag links and duplicate actors.
-- Additive. Safe on empty and existing Clients V2 rows within one business.

CREATE UNIQUE INDEX IF NOT EXISTS client_tag_business_id_uidx
  ON client_tag (business_id, id);

ALTER TABLE client_tag_link DROP CONSTRAINT IF EXISTS client_tag_link_tag_id_fkey;

ALTER TABLE client_tag_link DROP CONSTRAINT IF EXISTS client_tag_link_tag_tenant_fk;
ALTER TABLE client_tag_link
  ADD CONSTRAINT client_tag_link_tag_tenant_fk
  FOREIGN KEY (business_id, tag_id)
  REFERENCES client_tag (business_id, id)
  ON DELETE CASCADE;

ALTER TABLE client_duplicate_decision
  DROP CONSTRAINT IF EXISTS client_duplicate_decision_actor_user_scope;
ALTER TABLE client_duplicate_decision
  ADD CONSTRAINT client_duplicate_decision_actor_user_scope
  FOREIGN KEY (business_id, actor_user_id)
  REFERENCES business_member (business_id, user_id);
