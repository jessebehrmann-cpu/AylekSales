// Hand-rolled DB types matching the schema in supabase/schema.sql.
// Regenerate via `supabase gen types typescript` once a project is linked.

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export type Database = {
  __InternalSupabase: { PostgrestVersion: "12" };
  public: {
    Tables: {
      clients: {
        Row: Client;
        Insert: Omit<Client, "id" | "created_at" | "revenue_share_pct" | "status"> & {
          id?: string;
          created_at?: string;
          revenue_share_pct?: number;
          status?: ClientStatus;
        };
        Update: Partial<Client>;
        Relationships: [];
      };
      users: {
        Row: AppUser;
        Insert: Omit<AppUser, "created_at" | "role"> & {
          created_at?: string;
          role?: UserRole;
        };
        Update: Partial<AppUser>;
        Relationships: [];
      };
      leads: {
        Row: Lead;
        Insert: Omit<Lead, "id" | "created_at" | "updated_at" | "source" | "stage"> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          source?: Lead["source"];
          stage?: LeadStage;
        };
        Update: Partial<Lead>;
        Relationships: [];
      };
      campaigns: {
        Row: Campaign;
        Insert: Omit<Campaign, "id" | "created_at" | "status" | "leads_enrolled"> & {
          id?: string;
          created_at?: string;
          status?: CampaignStatus;
          leads_enrolled?: number;
        };
        Update: Partial<Campaign>;
        Relationships: [];
      };
      emails: {
        Row: Email;
        Insert: Omit<Email, "id" | "created_at" | "direction" | "status"> & {
          id?: string;
          created_at?: string;
          direction?: EmailDirection;
          status?: EmailStatus;
        };
        Update: Partial<Email>;
        Relationships: [];
      };
      meetings: {
        Row: Meeting;
        Insert: Omit<Meeting, "id" | "created_at" | "duration_minutes" | "format" | "status"> & {
          id?: string;
          created_at?: string;
          duration_minutes?: number;
          format?: MeetingFormat;
          status?: MeetingStatus;
        };
        Update: Partial<Meeting>;
        Relationships: [];
      };
      quotes: {
        Row: Quote;
        Insert: Omit<Quote, "id" | "created_at" | "status"> & {
          id?: string;
          created_at?: string;
          status?: QuoteStatus;
        };
        Update: Partial<Quote>;
        Relationships: [];
      };
      events: {
        Row: AppEvent;
        Insert: Omit<AppEvent, "id" | "created_at" | "payload"> & {
          id?: string;
          created_at?: string;
          payload?: Json;
        };
        Update: Partial<AppEvent>;
        Relationships: [];
      };
      queries: {
        Row: AppQuery;
        Insert: Omit<AppQuery, "id" | "created_at"> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<AppQuery>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

export type ClientStatus = "active" | "paused" | "churned";
export type LeadStage =
  | "new"
  | "contacted"
  | "replied"
  | "meeting_booked"
  | "quoted"
  | "won"
  | "lost"
  | "unsubscribed";
export type CampaignStatus = "draft" | "active" | "paused" | "complete";
export type EmailDirection = "outbound" | "inbound";
export type EmailStatus = "pending" | "sent" | "opened" | "replied" | "bounced" | "failed";
export type MeetingStatus = "scheduled" | "completed" | "no_show" | "cancelled";
export type MeetingFormat = "video" | "phone" | "in_person";
export type QuoteStatus = "sent" | "accepted" | "rejected" | "expired";
export type UserRole = "admin" | "sales_user";

export type EventType =
  | "email_sent"
  | "email_opened"
  | "email_replied"
  | "email_bounced"
  | "inbound_received"
  | "inbound_qualified"
  | "inbound_disqualified"
  | "stage_changed"
  | "meeting_booked"
  | "meeting_completed"
  | "meeting_no_show"
  | "quote_sent"
  | "quote_won"
  | "quote_lost"
  | "campaign_launched"
  | "campaign_paused"
  | "campaign_completed"
  | "note_added"
  | "lead_imported"
  | "query_run"
  | "ai_action";

export type Client = {
  id: string;
  name: string;
  owner_name: string | null;
  email: string | null;
  phone: string | null;
  suburb: string | null;
  retainer_amount: number | null;
  revenue_share_pct: number;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  status: ClientStatus;
  notes: string | null;
  created_at: string;
};

export type AppUser = {
  id: string;
  full_name: string | null;
  email: string | null;
  role: UserRole;
  created_at: string;
};

export type Lead = {
  id: string;
  client_id: string | null;
  company_name: string;
  contact_name: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  suburb: string | null;
  industry: string | null;
  employees_estimate: number | null;
  website: string | null;
  source: "import" | "manual" | "inbound" | "ai_enriched";
  stage: LeadStage;
  contract_value: number | null;
  assigned_to: string | null;
  last_contacted_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type SequenceStep = {
  step: number;
  delay_days: number;
  subject: string;
  body: string;
};

export type Campaign = {
  id: string;
  client_id: string | null;
  name: string;
  status: CampaignStatus;
  target_industry: string | null;
  target_title: string | null;
  sequence_steps: SequenceStep[] | null;
  leads_enrolled: number;
  created_by: string | null;
  created_at: string;
};

export type Email = {
  id: string;
  client_id: string | null;
  lead_id: string | null;
  campaign_id: string | null;
  direction: EmailDirection;
  step_number: number | null;
  subject: string | null;
  body: string | null;
  status: EmailStatus;
  resend_message_id: string | null;
  sent_at: string | null;
  opened_at: string | null;
  replied_at: string | null;
  reply_body: string | null;
  send_at: string | null;
  created_at: string;
};

export type Meeting = {
  id: string;
  client_id: string | null;
  lead_id: string | null;
  scheduled_at: string | null;
  duration_minutes: number;
  format: MeetingFormat;
  status: MeetingStatus;
  notes: string | null;
  created_at: string;
};

export type Quote = {
  id: string;
  client_id: string | null;
  lead_id: string | null;
  amount: number | null;
  frequency: "weekly" | "fortnightly" | "monthly" | null;
  scope: string | null;
  status: QuoteStatus;
  sent_at: string | null;
  responded_at: string | null;
  created_at: string;
};

export type AppEvent = {
  id: string;
  client_id: string | null;
  lead_id: string | null;
  campaign_id: string | null;
  user_id: string | null;
  event_type: EventType;
  payload: Json;
  created_at: string;
};

export type AppQuery = {
  id: string;
  client_id: string | null;
  user_id: string | null;
  question: string;
  generated_query: string | null;
  result_summary: string | null;
  created_at: string;
};
