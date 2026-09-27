-- Allow staff-created CRM leads with an explicit manual source.
-- Additive: widen CHECK only. Existing telegram/vk/max rows unchanged.

ALTER TABLE "lead" DROP CONSTRAINT IF EXISTS lead_source_check;
ALTER TABLE "lead"
  ADD CONSTRAINT lead_source_check
  CHECK ("source" IN ('telegram', 'vk', 'max', 'manual'));
