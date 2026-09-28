-- Orders V2: assignment, fulfillment/business settings, product_type, inventory ledger.
-- Additive only. Safe defaults preserve existing store/delivery behavior.

-- ---------------------------------------------------------------------------
-- Order assignment
-- ---------------------------------------------------------------------------
ALTER TABLE "order"
  ADD COLUMN IF NOT EXISTS assigned_user_id uuid NULL,
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS delivery_fee numeric(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS subtotal numeric(12, 2) NULL;

CREATE INDEX IF NOT EXISTS order_business_assigned_idx
  ON "order" (business_id, assigned_user_id, created_at DESC)
  WHERE assigned_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS order_business_source_idx
  ON "order" (business_id, source, created_at DESC);

CREATE INDEX IF NOT EXISTS order_business_fulfillment_idx
  ON "order" (business_id, fulfillment, created_at DESC);

ALTER TABLE "order" DROP CONSTRAINT IF EXISTS order_assigned_user_scope;
ALTER TABLE "order"
  ADD CONSTRAINT order_assigned_user_scope
  FOREIGN KEY (business_id, assigned_user_id)
  REFERENCES business_member (business_id, user_id);

-- Backfill subtotal from total when missing (historical rows had no separate fee).
UPDATE "order"
SET subtotal = total
WHERE subtotal IS NULL;

-- ---------------------------------------------------------------------------
-- Order settings: fulfillment + business mode
-- ---------------------------------------------------------------------------
ALTER TABLE order_settings
  ADD COLUMN IF NOT EXISTS pickup_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS pickup_address text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS pickup_instructions text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS delivery_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS delivery_price numeric(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS free_delivery_from numeric(12, 2) NULL,
  ADD COLUMN IF NOT EXISTS minimum_order_amount numeric(12, 2) NULL,
  ADD COLUMN IF NOT EXISTS delivery_description text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS business_mode text NOT NULL DEFAULT 'store';

ALTER TABLE order_settings DROP CONSTRAINT IF EXISTS order_settings_business_mode_check;
ALTER TABLE order_settings
  ADD CONSTRAINT order_settings_business_mode_check
  CHECK (business_mode IN ('store', 'service', 'combined'));

-- Ensure every business has a settings row (preserve cancel defaults).
INSERT INTO order_settings (business_id)
SELECT b.id FROM business b
WHERE NOT EXISTS (
  SELECT 1 FROM order_settings s WHERE s.business_id = b.id
)
ON CONFLICT (business_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Product type (product | service)
-- ---------------------------------------------------------------------------
ALTER TABLE product
  ADD COLUMN IF NOT EXISTS product_type text NOT NULL DEFAULT 'product';

ALTER TABLE product DROP CONSTRAINT IF EXISTS product_type_check;
ALTER TABLE product
  ADD CONSTRAINT product_type_check
  CHECK (product_type IN ('product', 'service'));

CREATE INDEX IF NOT EXISTS product_business_type_idx
  ON product (business_id, product_type, active);

-- ---------------------------------------------------------------------------
-- Inventory movement ledger (additive audit of stock changes)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_movement (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES business (id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  variant_id uuid NULL,
  delta integer NOT NULL,
  remaining integer NULL,
  reason text NOT NULL,
  order_id uuid NULL,
  actor_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_movement_reason_check
    CHECK (reason IN (
      'manual_adjustment',
      'order_checkout',
      'order_cancelled',
      'restock'
    ))
);

CREATE UNIQUE INDEX IF NOT EXISTS product_business_id_uidx
  ON product (business_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS product_variant_business_id_uidx
  ON product_variant (business_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS order_business_id_uidx
  ON "order" (business_id, id);

ALTER TABLE inventory_movement DROP CONSTRAINT IF EXISTS inventory_movement_product_tenant_fk;
ALTER TABLE inventory_movement
  ADD CONSTRAINT inventory_movement_product_tenant_fk
  FOREIGN KEY (business_id, product_id)
  REFERENCES product (business_id, id)
  ON DELETE CASCADE;

ALTER TABLE inventory_movement DROP CONSTRAINT IF EXISTS inventory_movement_variant_tenant_fk;
ALTER TABLE inventory_movement
  ADD CONSTRAINT inventory_movement_variant_tenant_fk
  FOREIGN KEY (business_id, variant_id)
  REFERENCES product_variant (business_id, id)
  ON DELETE SET NULL;

ALTER TABLE inventory_movement DROP CONSTRAINT IF EXISTS inventory_movement_order_tenant_fk;
ALTER TABLE inventory_movement
  ADD CONSTRAINT inventory_movement_order_tenant_fk
  FOREIGN KEY (business_id, order_id)
  REFERENCES "order" (business_id, id)
  ON DELETE SET NULL;

ALTER TABLE inventory_movement DROP CONSTRAINT IF EXISTS inventory_movement_actor_scope;
ALTER TABLE inventory_movement
  ADD CONSTRAINT inventory_movement_actor_scope
  FOREIGN KEY (business_id, actor_user_id)
  REFERENCES business_member (business_id, user_id);

CREATE INDEX IF NOT EXISTS inventory_movement_business_created_idx
  ON inventory_movement (business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS inventory_movement_product_idx
  ON inventory_movement (business_id, product_id, created_at DESC);
