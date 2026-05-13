// Hand-rolled DB types matching the schema in supabase/schema.sql.
// Regenerate via `supabase gen types typescript` once a project is linked.

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export type Database = {
  __InternalSupabase: { PostgrestVersion: "12" };
  public: {
    Tables: {
      clients: {
        Row: Client;
        Insert: Partial<Omit<Client, "name">> & { name: string };
        Update: Partial<Client>;
        Relationships: [];
      };
      users: {
        Row: AppUser;
        Insert: Partial<Omit<AppUser, "id">> & { id: string };
        Update: Partial<AppUser>;
        Relationships: [];
      };
      leads: {
        Row: Lead;
        Insert: Partial<Omit<Lead, "company_name">> & { company_name: string };
        Update: Partial<Lead>;
        Relationships: [];
      };
      campaigns: {
        Row: Campaign;
        Insert: Partial<Omit<Campaign, "name">> & { name: string };
        Update: Partial<Campaign>;
        Relationships: [];
      };
      emails: {
        Row: Email;
        Insert: Partial<Email>;
        Update: Partial<Email>;
        Relationships: [];
      };
      meetings: {
        Row: Meeting;
        Insert: Partial<Meeting>;
        Update: Partial<Meeting>;
        Relationships: [];
      };
      quotes: {
        Row: Quote;
        Insert: Partial<Quote>;
        Update: Partial<Quote>;
        Relationships: [];
      };
      events: {
        Row: AppEvent;
        Insert: Partial<Omit<AppEvent, "event_type" | "payload">> & {
          event_type: EventType;
          payload?: Json;
        };
        Update: Partial<AppEvent>;
        Relationships: [];
      };
      queries: {
        Row: AppQuery;
        Insert: Partial<AppQuery>;
        Update: Partial<AppQuery>;
        Relationships: [];
      };
      playbooks: {
        Row: Playbook;
        Insert: Partial<Omit<Playbook, "client_id">> & { client_id: string };
        Update: Partial<Playbook>;
        Relationships: [];
      };
      playbook_versions: {
        Row: PlaybookVersion;
        Insert: Partial<PlaybookVersion>;
        Update: Partial<PlaybookVersion>;
        Relationships: [];
      };
      approvals: {
        Row: Approval;
        Insert: Partial<Omit<Approval, "client_id" | "type" | "title">> & {
          client_id: string;
          type: ApprovalType;
          title: string;
        };
        Update: Partial<Approval>;
        Relationships: [];
      };
      meeting_notes: {
        Row: MeetingNote;
        Insert: Partial<Omit<MeetingNote, "lead_id" | "outcome">> & {
          lead_id: string;
          outcome: MeetingOutcome;
        };
        Update: Partial<MeetingNote>;
        Relationships: [];
      };
      onboarding_sessions: {
        Row: OnboardingSession;
        Insert: Partial<Omit<OnboardingSession, "client_id">> & { client_id: string };
        Update: Partial<OnboardingSession>;
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

export type LeadApprovalStatus = "pending_approval" | "approved" | "rejected";

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
  approval_status: LeadApprovalStatus;
  /** Pointer at the current SalesProcessStage.id from the lead's playbook. */
  process_stage_id: string | null;
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

// ── Playbooks ──────────────────────────────────────────────────────────────

export type PlaybookStatus = "draft" | "pending_approval" | "approved";
export type ApprovalType =
  | "lead_list"
  | "strategy_change"
  | "human_stage_task"
  | "proposal_review"
  | "playbook_approval";

export type MeetingOutcome = "positive" | "neutral" | "negative" | "no_show";

export type MeetingNote = {
  id: string;
  lead_id: string;
  client_id: string | null;
  outcome: MeetingOutcome;
  notes: string | null;
  transcript: string | null;
  objections: string | null;
  next_steps: string | null;
  drafted_proposal_subject: string | null;
  drafted_proposal_body: string | null;
  related_approval_id: string | null;
  created_by: string | null;
  created_at: string;
};

/**
 * Payload shape for type='human_stage_task' approvals — one is created
 * each time a lead enters a human-owned sales-process stage.
 */
export type HumanStageTaskPayload = {
  stage_id: string;
  stage_name: string;
  agent: string;
  message: string;
};

/**
 * Payload shape for type='proposal_review' approvals — created either after
 * a Have-Meeting completion (with meeting context) or auto-created when a
 * lead enters the Send Proposal stage from any other path. `lead_id` is the
 * authoritative pointer; `meeting_note_id` is only present when the
 * approval was anchored on a captured meeting note.
 */
export type ProposalReviewPayload = {
  lead_id: string;
  meeting_note_id: string | null;
  drafted_subject: string;
  drafted_body: string;
  outcome: MeetingOutcome | null;
  source: "post_meeting" | "auto_on_send_proposal";
  ai_warning?: string | null;
};
export type ApprovalStatus = "pending" | "approved" | "rejected";

export type ICP = {
  industries?: string[];
  company_size?: string;
  target_titles?: string[];
  geography?: string[];
  qualification_signal?: string;
  disqualifiers?: string[];
  /** Optional explicit list of company domains to source against. Required
   *  when Prospect-01 is running with the Hunter.io provider (Hunter is
   *  domain-driven, not industry-driven). Ignored by Apollo. */
  target_domains?: string[];
};

export type PlaybookSequenceStep = {
  step: number;
  subject: string;
  body: string;
  delay_days: number;
  /** Index into Playbook.team_members for the From: name on this step. */
  sender_index?: number | null;
  branching_rules?: {
    on_open?: { wait_days?: number };
    on_no_reply?: { wait_days?: number };
  };
};

export type EscalationRule = {
  after_step: number;
  action: "pause" | "notify" | "handoff";
  notify_email?: string;
};

export type ChannelFlags = {
  email: boolean;
  phone: boolean;
  linkedin: boolean;
};

export type Strategy = {
  value_proposition?: string;
  key_messages?: string[];
  proof_points?: string[];
  objection_responses?: Array<{ objection: string; response: string }>;
};

export type VoiceTone = {
  tone_descriptors?: string[];
  writing_style?: string;
  avoid?: string[];
  example_phrases?: string[];
};

export type ReplyKind =
  | "interested"
  | "not_now"
  | "wrong_person"
  | "unsubscribe"
  | "objection";

export type ReplyStrategy = Partial<
  Record<
    ReplyKind,
    {
      action?: string;
      template?: string;
    }
  >
>;

export type TeamMember = {
  id: string;
  name: string;
  title: string;
  email: string;
};

/**
 * One stage of the client's sales process. Agents read this to know what
 * stage they're operating in and what comes next. The `agent` field is the
 * canonical handle of the agent responsible (e.g. "prospect-01",
 * "outreach-01", "hos", "human-rep"). Fully customisable per client.
 */
export type SalesProcessStage = {
  id: string;
  name: string;
  description: string;
  agent: string;
  /** Optional gating condition the engine reads before triggering this stage.
   *  Plain English; `auto` means no gate (default). */
  condition?: string | null;
};

export type Playbook = {
  id: string;
  client_id: string;
  version: number;
  status: PlaybookStatus;
  icp: ICP;
  sequences: PlaybookSequenceStep[];
  escalation_rules: EscalationRule[];
  channel_flags: ChannelFlags;
  strategy: Strategy;
  voice_tone: VoiceTone;
  reply_strategy: ReplyStrategy;
  team_members: TeamMember[];
  sales_process: SalesProcessStage[];
  notes: string | null;
  created_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PlaybookVersion = {
  id: string;
  playbook_id: string;
  client_id: string;
  version: number;
  status: PlaybookStatus;
  snapshot: Json;
  changed_by: string | null;
  change_reason: string | null;
  created_at: string;
};

export type LeadListPayload = {
  lead_ids: string[];
  campaign_id?: string;
  source?: string;
};

export type StrategyChangePayload = {
  playbook_id: string;
  diff: Array<{ path: string; before: unknown; after: unknown }>;
  reasoning?: string;
  source?: string;
};

export type Approval = {
  id: string;
  client_id: string;
  type: ApprovalType;
  status: ApprovalStatus;
  title: string;
  summary: string | null;
  payload: LeadListPayload | StrategyChangePayload | Record<string, unknown>;
  related_playbook_id: string | null;
  related_campaign_id: string | null;
  created_by: string | null;
  approved_by: string | null;
  decided_at: string | null;
  created_at: string;
};

// ── Onboarding sessions ────────────────────────────────────────────────────

export type OnboardingStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "playbook_generated"
  | "approved";

/** One Q+A turn in the conversational interview. `topic` lets us track
 *  coverage of the core sections (icp, strategy, voice, etc). */
export type OnboardingAnswer = {
  topic: string;
  question: string;
  answer: string;
  asked_at: string;
};

/** The five reviewable playbook sections in order. The contact approves
 *  each one independently before the playbook is written. */
export type OnboardingSectionId =
  | "icp"
  | "strategy"
  | "voice_tone"
  | "sequences"
  | "sales_process";

export type OnboardingAnswers = {
  questions?: OnboardingAnswer[];
  /** Free-form notes the contact added at the end. */
  notes?: string;
  /** Set when the contact has clicked "I'm done" — terminates the loop. */
  done?: boolean;
  /** First name the contact gave at the intro slide. Used to personalise
   *  every subsequent question and the generated content. */
  contact_name?: string;
  /** Company name the contact gave at the intro slide. Authoritative
   *  display name for the public onboarding page; the linked
   *  clients.name is internal. */
  company_name?: string;
  /** Per-section client approvals. The whole-playbook write only happens
   *  when every section is true. */
  section_approvals?: Partial<Record<OnboardingSectionId, boolean>>;
};

export type OnboardingFeedbackRound = {
  requested_at: string;
  feedback: string;
  /** When set, this round was a single-section regeneration. */
  section?: OnboardingSectionId;
  /** Snapshot of just the section being changed (when section is set). */
  prior_section?: unknown;
  /** Snapshot of the entire playbook (when this was a whole-playbook regen). */
  prior_playbook: GeneratedPlaybookDraft | null;
};

/** Shape of the playbook draft generated by Claude during onboarding.
 *  Mirrors the storage columns on public.playbooks so we can write it back
 *  on approval with no remapping. */
export type GeneratedPlaybookDraft = {
  icp: ICP;
  strategy: Strategy;
  voice_tone: VoiceTone;
  reply_strategy: ReplyStrategy;
  team_members: TeamMember[];
  sales_process: SalesProcessStage[];
  sequences: PlaybookSequenceStep[];
  channel_flags?: ChannelFlags;
  escalation_rules?: EscalationRule[];
  notes?: string | null;
};

export type OnboardingSession = {
  id: string;
  client_id: string;
  lead_id: string | null;
  token: string;
  status: OnboardingStatus;
  answers: OnboardingAnswers;
  generated_playbook: GeneratedPlaybookDraft | null;
  feedback_rounds: OnboardingFeedbackRound[];
  sent_at: string | null;
  completed_at: string | null;
  approved_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

/** Payload shape for type='playbook_approval' approvals — created when the
 *  client signs off on their generated playbook and HOS needs to give
 *  final approval before the agents go live. */
export type PlaybookApprovalPayload = {
  onboarding_session_id: string;
  client_id: string;
  client_name: string;
  feedback_round_count: number;
};
