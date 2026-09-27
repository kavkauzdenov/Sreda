import type { Generated } from "kysely";

export type ClientTables = {
  client: {
    id: string;
    business_id: string;
    name: string;
    phone: string | null;
    email: string | null;
    first_seen_at: Generated<Date>;
    last_seen_at: Generated<Date>;
    archived_at: Date | null;
    merged_into_id: string | null;
    assigned_user_id: string | null;
    assigned_at: Date | null;
    profile_note: string | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  client_identity: {
    business_id: string;
    client_id: string;
    kind: "telegram" | "vk" | "whatsapp" | "instagram" | "phone" | "email";
    value: string;
    username: string | null;
    verified_at: Generated<Date>;
  };
  client_activity: {
    id: string;
    business_id: string;
    client_id: string;
    type: string;
    target_id: string | null;
    actor_user_id: string | null;
    metadata: Generated<unknown>;
    event_key: string;
    created_at: Generated<Date>;
  };
  client_note: {
    id: string;
    business_id: string;
    client_id: string;
    actor_user_id: string;
    text: string;
    created_at: Generated<Date>;
  };
  client_tag: {
    id: string;
    business_id: string;
    name: string;
    name_normalized: string;
    color_key: string;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  client_tag_link: {
    business_id: string;
    client_id: string;
    tag_id: string;
    created_at: Generated<Date>;
  };
  client_duplicate_decision: {
    id: string;
    business_id: string;
    client_a_id: string;
    client_b_id: string;
    decision: "separate" | "merged";
    actor_user_id: string;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  notification: {
    id: string;
    business_id: string;
    type: string;
    title: string;
    body: string;
    event_key: string;
    created_at: Generated<Date>;
  };
  notification_recipient: {
    notification_id: string;
    user_id: string;
    read_at: Date | null;
  };
};
