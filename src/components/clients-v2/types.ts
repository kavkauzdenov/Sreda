/** Clients V2 frontend types (mirror server DTOs). */

export type ClientChannel = "telegram" | "vk" | "whatsapp" | "instagram";

export type ClientActivityFilter = "today" | "7d" | "30d" | "inactive";

export type ClientFilterValues = {
  search: string;
  channel: ClientChannel | "";
  activity: ClientActivityFilter | "";
  hasLeads: boolean;
  hasOrders: boolean;
  hasBookings: boolean;
  hasOpenConversation: boolean;
  hasNotes: boolean;
  tagId: string;
  assignedUserId: string;
  newOnly: boolean;
};

export const EMPTY_CLIENT_FILTERS: ClientFilterValues = {
  search: "",
  channel: "",
  activity: "",
  hasLeads: false,
  hasOrders: false,
  hasBookings: false,
  hasOpenConversation: false,
  hasNotes: false,
  tagId: "",
  assignedUserId: "",
  newOnly: false,
};

export type ClientSummary = {
  total: number;
  new30d: number;
  active30d: number;
  openConversations: number;
};

export type ClientTag = {
  id: string;
  name: string;
  colorKey: string;
};

export type ClientAssignee = {
  id: string;
  name: string;
  role: string;
} | null;

export type ClientIdentity = {
  kind: string;
  value: string;
  username: string | null;
};

export type ClientLastActivity = {
  type: string;
  title: string;
  createdAt: string;
} | null;

export type ClientListItem = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  identities: ClientIdentity[];
  tags: ClientTag[];
  assignedUser: ClientAssignee;
  leadCount: number;
  orderCount: number;
  bookingCount: number;
  openConversation: boolean;
  lastActivity: ClientLastActivity;
};

export type ClientListResponse = {
  items: ClientListItem[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type ClientDetail = {
  client: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
    profileNote: string | null;
    assignedAt: string | null;
    updatedAt: string;
  };
  identities: ClientIdentity[];
  tags: ClientTag[];
  assignedUser: ClientAssignee;
  stats: {
    leadCount: number;
    orderCount: number;
    bookingCount: number;
    noteCount: number;
    conversationCount: number;
    openConversation: boolean;
    orderTotals: { currency: string; amount: string }[];
  };
  latestActivity: ClientLastActivity;
  latestNote: {
    id: string;
    text: string;
    createdAt: string;
    author: string | null;
  } | null;
  duplicateSummary: {
    count: number;
    candidates: {
      id: string;
      name: string;
      matches: string[];
    }[];
  };
  writeChannels: {
    platform: string;
    conversationId: string;
    username: string | null;
  }[];
};

export type TimelineItem = {
  id: string;
  type: string;
  createdAt: string;
  title: string;
  description: string | null;
  actor: string | null;
  entityType: string | null;
  entityId: string | null;
  targetPath: string | null;
  metadata: Record<string, unknown> | null;
};

export type CursorPage<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type ClientTab = {
  id: string;
  name: string;
  status: string;
  source?: string;
  phone?: string | null;
  createdAt?: string;
  total?: string;
  currency?: string;
  number?: number | string | null;
  startsAt?: string;
  serviceName?: string;
  specialistName?: string;
  platform?: string;
  updatedAt?: string;
  text?: string;
  author?: string | null;
  targetPath?: string | null;
};

export type ClientDetailTab =
  | "overview"
  | "timeline"
  | "leads"
  | "orders"
  | "bookings"
  | "conversations"
  | "notes";

export type CreateClientInput = {
  name: string;
  phone?: string;
  email?: string;
  assignedUserId?: string | null;
  tags?: string[];
  note?: string;
  profileNote?: string;
};

export type UpdateClientInput = {
  name?: string;
  phone?: string | null;
  email?: string | null;
  assignedUserId?: string | null;
  profileNote?: string | null;
};
