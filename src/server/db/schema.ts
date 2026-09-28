import type { NotificationTables } from "../notifications/schema.ts";
import type { AttachmentTables } from "../attachments/schema.ts";
import type { PostTables } from "../posts/schema.ts";
import type { BookingTables } from "../booking/schema.ts";
import type { ClientTables } from "../clients/schema.ts";
import type { OrderTables } from "../orders/schema.ts";
import type { CalendarTables } from "../calendar/schema.ts";
import type { AnalyticsTables } from "../analytics/schema.ts";
import type { Generated } from "kysely";

export type Role = "owner" | "admin" | "operator";
export type LeadStatus =
  | "new"
  | "processing"
  | "waiting_customer"
  | "completed"
  | "rejected"
  | "closed";
export type BusinessType = "store" | "service" | "hybrid";
export type SetupMode = "guided" | "advanced";
export type BusinessModel = "services" | "commerce" | "hybrid";
export interface Database
  extends NotificationTables,
    ClientTables,
    BookingTables,
    PostTables,
    AttachmentTables,
    OrderTables,
    CalendarTables,
    AnalyticsTables {
  account_pin: {
    user_id: string;
    pin_hash: string;
    failed_attempts: Generated<number>;
    locked_until: Date | null;
    updated_at: Generated<Date>;
  };
  platform_admin_mfa_session: {
    session_id: string;
    user_id: string;
    verified_at: Generated<Date>;
  };
  worker_heartbeat: { name: string; seen_at: Date };
  lead_setup: {
    business_id: string;
    draft: string;
    revision: number;
    updated_at: Date;
  };
  business_solution: {
    business_id: string;
    solution_code: string;
    status: "active" | "trial" | "expired" | "disabled" | "paused";
    starts_at: Date;
    expires_at: Date | null;
    disabled_at: Date | null;
    paused_at: Date | null;
    settings_reset_at: Date | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  /** Payment catalog — documentation / future checkout; not entitlement SoT. */
  billing_plan: {
    code: string;
    name: string;
    description: string;
    currency: string;
    unit_price_minor: number;
    interval: "month" | "year" | "one_time";
    solution_code: string | null;
    active: boolean;
    created_at: Generated<Date>;
  };
  /** Provider subscription ledger; entitlement remains business_solution. */
  business_subscription: {
    id: string;
    business_id: string;
    status: "trialing" | "active" | "past_due" | "cancelled" | "expired";
    provider: "none" | "noop" | "mock" | "yookassa" | "stripe";
    provider_customer_id: string | null;
    provider_subscription_id: string | null;
    current_period_start: Date | null;
    current_period_end: Date | null;
    cancel_at_period_end: boolean;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  business_subscription_item: {
    id: string;
    subscription_id: string;
    business_id: string;
    solution_code: string;
    plan_code: string | null;
    unit_price_minor: number;
    currency: string;
    quantity: number;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  ai_usage_event: {
    id: Generated<string>;
    business_id: string;
    feature: string;
    model: Generated<string>;
    request_count: Generated<number>;
    input_tokens: number | null;
    output_tokens: number | null;
    estimated_cost_minor: number | null;
    currency: Generated<string>;
    created_at: Generated<Date>;
  };
  product_event: {
    id: string;
    business_id: string | null;
    user_id: string | null;
    event: string;
    meta: Generated<unknown>;
    created_at: Generated<Date>;
  };
  reply_template: {
    id: string;
    business_id: string;
    title: string;
    body: string;
    created_by: string | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
    archived_at: Date | null;
  };
  solution_config: {
    business_id: string;
    solution_code: string;
    config: unknown;
    revision: number;
    updated_at: Generated<Date>;
  };
  integration_key: {
    business_id: string;
    key_hash: string;
    key_hint: string;
    created_at: Generated<Date>;
    rotated_at: Date | null;
    revoked_at: Date | null;
  };
  telegram_runtime: {
    connection_id: string;
    generation: string;
    status: "pending" | "ready" | "error";
    updated_at: Generated<Date>;
  };
  vk_dialog: Database["telegram_dialog"];
  telegram_dialog: {
    mode: Generated<string>;
    config: Generated<string>;
    connection_id: string;
    chat_id: string;
    fields: string;
    answers: string;
    position: number;
    last_update_id: string;
    updated_at: Generated<Date>;
  };
  telegram_update: {
    connection_id: string;
    update_id: string;
    created_at: Generated<Date>;
  };
  telegram_outbox: {
    notification_id: Generated<string | null>;
    notification_user_id: Generated<string | null>;
    post_step: Generated<number>;
    attachment_ids: Generated<unknown>;
    post_delivery_id: Generated<string | null>;
    api_payload: Generated<unknown>;
    booking_reminder_id: Generated<string | null>;
    entity_reminder_id: Generated<string | null>;
    delivery_state: Generated<
      "pending" | "sending" | "sent" | "failed" | "uncertain"
    >;
    claimed_at: Generated<Date | null>;
    external_message_id: Generated<string | null>;
    communication_message_id: Generated<string | null>;
    buttons: Generated<unknown>;
    id: Generated<string>;
    connection_id: string;
    chat_id: string;
    message: string;
    attempts: Generated<number>;
    available_at: Generated<Date>;
    delivered_at: Date | null;
    last_error: string | null;
    created_at: Generated<Date>;
  };
  vk_runtime: {
    confirmation_code: Generated<string | null>;
    server_id: Generated<number | null>;
    setup_lock_until: Generated<Date | null>;
    connection_id: string;
    generation: string;
    status: "pending" | "ready" | "error";
    updated_at: Generated<Date>;
  };
  vk_update: {
    connection_id: string;
    event_id: string;
    created_at: Generated<Date>;
  };
  vk_outbox: {
    notification_id: Generated<string | null>;
    notification_user_id: Generated<string | null>;
    post_step: Generated<number>;
    attachment_ids: Generated<unknown>;
    post_delivery_id: Generated<string | null>;
    api_payload: Generated<unknown>;
    booking_reminder_id: Generated<string | null>;
    entity_reminder_id: Generated<string | null>;
    delivery_state: Generated<
      "pending" | "sending" | "sent" | "failed" | "uncertain"
    >;
    claimed_at: Generated<Date | null>;
    external_message_id: Generated<string | null>;
    communication_message_id: Generated<string | null>;
    buttons: Generated<unknown>;
    id: Generated<string>;
    connection_id: string;
    peer_id: string;
    message: string;
    attempts: Generated<number>;
    available_at: Generated<Date>;
    delivered_at: Date | null;
    last_error: string | null;
    created_at: Generated<Date>;
  };
  meta_runtime: {
    connection_id: string;
    generation: string;
    status: "pending" | "ready" | "error";
    waba_id: string | null;
    phone_number_id: string | null;
    display_phone_number: string | null;
    page_id: string | null;
    ig_user_id: string | null;
    ig_username: string | null;
    webhook_subscribed: Generated<boolean>;
    last_error: string | null;
    updated_at: Generated<Date>;
  };
  meta_update: {
    connection_id: string;
    event_id: string;
    created_at: Generated<Date>;
  };
  meta_outbox: {
    id: Generated<string>;
    connection_id: string;
    recipient_id: string;
    message: Generated<string>;
    buttons: Generated<unknown>;
    attachment_ids: Generated<unknown>;
    api_payload: Generated<unknown>;
    attempts: Generated<number>;
    available_at: Generated<Date>;
    delivered_at: Date | null;
    last_error: string | null;
    created_at: Generated<Date>;
    delivery_state: Generated<
      "pending" | "sending" | "sent" | "failed" | "uncertain"
    >;
    claimed_at: Generated<Date | null>;
    external_message_id: Generated<string | null>;
    communication_message_id: Generated<string | null>;
    notification_id: Generated<string | null>;
    notification_user_id: Generated<string | null>;
    template_name: Generated<string | null>;
    template_language: Generated<string | null>;
  };
  meta_oauth_state: {
    id: string;
    business_id: string;
    user_id: string;
    platform: "whatsapp" | "instagram";
    state_hash: string;
    status: "pending" | "consumed" | "expired" | "failed";
    payload: Generated<unknown>;
    expires_at: Date;
    consumed_at: Date | null;
    created_at: Generated<Date>;
  };

  user: {
    id: string;
    public_id: string;
    name: string;
    username: string;
    email: string;
    deleted_at: Date | null;
    deletion_status: "active" | "pending" | "deleted";
    createdAt: Generated<Date>;
    updatedAt: Generated<Date>;
  };
  account: {
    id: string;
    userId: string;
    providerId: string;
    password: string | null;
    updatedAt: Date;
  };
  session: {
    id: string;
    userId: string;
    token: string;
    expiresAt: Date;
    updatedAt: Date;
    createdAt: Generated<Date>;
    ipAddress: string | null;
    userAgent: string | null;
  };
  platform_admin: {
    user_id: string;
    role: "SUPER_ADMIN" | "SUPPORT" | "MODERATOR" | "FINANCE";
    status: "active" | "revoked";
    created_at: Generated<Date>;
    created_by: string | null;
    updated_at: Generated<Date>;
    revoked_at: Date | null;
  };
  platform_admin_audit_log: {
    id: string;
    admin_user_id: string;
    admin_role: string;
    action: string;
    target_type: string;
    target_id: string | null;
    business_id: string | null;
    reason: string | null;
    metadata: Generated<unknown>;
    request_id: string | null;
    created_at: Generated<Date>;
  };
  platform_suspension: {
    entity_type: "user" | "business";
    entity_id: string;
    reason: string;
    created_by: string;
    created_at: Generated<Date>;
    lifted_at: Date | null;
    lifted_by: string | null;
  };
  platform_admin_bootstrap: {
    id: boolean;
    used_at: Date | null;
    used_by: string | null;
  };
  recovery_code: {
    user_id: string;
    code_hash: string;
    created_at: Generated<Date>;
    used_at: Date | null;
  };
  account_security_event: {
    id: string;
    user_id: string;
    action:
      | "recovery_codes_issued"
      | "password_recovered"
      | "password_changed"
      | "pin_enabled"
      | "pin_changed"
      | "pin_disabled"
      | "account_deletion_requested"
      | "account_deletion_completed";
    created_at: Generated<Date>;
  };
  account_deletion_request: {
    id: string;
    user_id: string;
    token_hash: string;
    impact_snapshot: Generated<unknown>;
    business_decisions: Generated<unknown>;
    expires_at: Date;
    consumed_at: Date | null;
    created_at: Generated<Date>;
  };
  business_deletion_request: {
    id: string;
    business_id: string;
    user_id: string;
    token_hash: string;
    impact_snapshot: Generated<unknown>;
    expires_at: Date;
    consumed_at: Date | null;
    created_at: Generated<Date>;
  };
  business: {
    id: string;
    public_id: string;
    name: string;
    timezone: string;
    public_name: Generated<string | null>;
    greeting: Generated<string>;
    description: Generated<string>;
    contact_info: Generated<string>;
    business_type: Generated<BusinessType>;
    industry: Generated<string | null>;
    industry_subtype: Generated<string | null>;
    business_model: Generated<BusinessModel | null>;
    setup_mode: Generated<SetupMode>;
    capabilities: Generated<unknown>;
    setup_progress: Generated<unknown>;
    onboarding_completed_at: Generated<Date | null>;
    ai_about: Generated<string>;
    ai_tone: Generated<string>;
    ai_important_facts: Generated<string>;
    ai_restrictions: Generated<string>;
    ai_delivery_info: Generated<string>;
    ai_geography: Generated<string>;
    ai_returns_info: Generated<string>;
    ai_extra_instructions: Generated<string>;
    ai_interview: Generated<unknown>;
    ai_summary_confirmed_at: Generated<Date | null>;
    created_at: Generated<Date>;
    archived_at: Date | null;
  };
  business_member: {
    business_id: string;
    user_id: string;
    role: Role;
    status: "active" | "revoked";
    created_at: Generated<Date>;
  };
  business_creation: {
    user_id: string;
    key: string;
    request_hash: string;
    business_id: string;
    created_at: Generated<Date>;
  };
  request_limit: { key: string; count: number; expires_at: Date };
  business_invitation: {
    id: string;
    business_id: string;
    inviter_user_id: string;
    invitee_user_id: string;
    role: "admin" | "operator";
    status: "pending" | "accepted" | "revoked" | "expired" | "declined";
    expires_at: Date;
    created_at: Generated<Date>;
    responded_at: Date | null;
  };
  business_audit_log: {
    id: string;
    business_id: string;
    actor_user_id: string | null;
    actor_type: Generated<"member" | "client" | "system">;
    target_id: Generated<string | null>;
    metadata: Generated<unknown>;
    action:
      | "invitation_created"
      | "invitation_accepted"
      | "invitation_revoked"
      | "invitation_declined"
      | "member_revoked"
      | "member_role_changed"
      | "connection_connected"
      | "connection_disconnected"
      | "lead_taken"
      | "lead_closed"
      | "conversation_taken"
      | "conversation_closed"
      | "booking_created"
      | "booking_rescheduled"
      | "booking_cancelled"
      | "booking_completed"
      | "service_created"
      | "service_updated"
      | "specialist_created"
      | "specialist_updated"
      | "post_created"
      | "post_scheduled"
      | "post_cancelled"
      | "post_published"
      | "product_created"
      | "product_updated"
      | "order_created"
      | "order_status_changed"
      | "inventory_adjusted"
      | "settings_changed"
      | "calendar_event_created"
      | "calendar_event_updated"
      | "calendar_event_cancelled"
      | "analytics_file_uploaded"
      | "analytics_file_deleted"
      | "analytics_export_created"
      | "analytics_ai_created"
      | "analytics_import_confirmed"
      | "client_merged"
      | "conversation_internal_note"
      | "data_import_committed"
      | "solution.setup_cancelled"
      | "solution.paused"
      | "solution.resumed"
      | "solution.disabled"
      | "solution.reenabled"
      | "solution.settings_reset";
    target_user_id: string | null;
    details: string | null;
    created_at: Generated<Date>;
  };
  business_connection: {
    id: string;
    business_id: string;
    platform: "telegram" | "vk" | "whatsapp" | "instagram";
    external_account_id: string | null;
    display_name: string | null;
    status: "pending" | "connected" | "error" | "disconnected";
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  connection_secret: {
    encrypted_publish_token: Generated<string | null>;
    connection_id: string;
    encrypted_token: string;
    key_version: number;
    updated_at: Generated<Date>;
  };
  lead: {
    processing_by: Generated<string | null>;
    processing_at: Generated<Date | null>;
    answers: Generated<unknown>;
    client_id: Generated<string | null>;
    id: string;
    business_id: string;
    source: "telegram" | "vk" | "max" | "manual";
    name: string;
    phone: string | null;
    message: string | null;
    status: LeadStatus;
    external_event_id: string | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  lead_form_field: {
    id: string;
    business_id: string;
    field_key: string;
    label: string;
    field_type: string;
    required: Generated<boolean>;
    placeholder: Generated<string>;
    options: Generated<unknown>;
    position: Generated<number>;
    active: Generated<boolean>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  lead_status_history: {
    id: string;
    business_id: string;
    lead_id: string;
    from_status: string | null;
    to_status: string;
    actor_user_id: string | null;
    note: Generated<string>;
    created_at: Generated<Date>;
  };
  communication_conversation: {
    client_id: Generated<string | null>;
    id: string;
    business_id: string;
    platform: "telegram" | "vk" | "whatsapp" | "instagram";
    external_user_id: string;
    external_username: string | null;
    status: "open" | "assigned" | "closed" | "blocked";
    assigned_member_user_id: string | null;
    last_message_at: Generated<Date>;
    last_inbound_at: Generated<Date | null>;
    created_at: Generated<Date>;
    closed_at: Date | null;
  };
  communication_message: {
    delivery_status: Generated<"queued" | "sent" | "failed" | "uncertain">;
    request_key: Generated<string | null>;
    id: string;
    conversation_id: string;
    business_id: string;
    direction: "inbound" | "outbound" | "internal";
    text: string;
    external_message_id: string | null;
    actor_user_id: string | null;
    moderation_status: "allowed" | "pending" | "blocked";
    created_at: Generated<Date>;
  };
  conversation_read_state: {
    business_id: string;
    conversation_id: string;
    user_id: string;
    read_at: Date;
  };
  communication_quota: {
    business_id: string;
    period_start: string;
    inbound_limit: number;
    inbound_count: number;
    warned_at_percent: 0 | 80 | 100;
    updated_at: Generated<Date>;
  };
  communication_block: {
    id: string;
    business_id: string;
    platform: "telegram" | "vk" | "whatsapp" | "instagram";
    external_user_id: string;
    reason: string;
    expires_at: Date | null;
    created_at: Generated<Date>;
  };
}
