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
      suppressed_emails: {
        Row: SuppressedEmail;
        Insert: Partial<Omit<SuppressedEmail, "email" | "reason">> & {
          email: string;
          reason: SuppressedEmailReason;
        };
        Update: Partial<SuppressedEmail>;
        Relationships: [];
      };
      usage_events: {
        Row: UsageEvent;
        Insert: Partial<Omit<UsageEvent, "kind">> & { kind: string };
        Update: Partial<UsageEvent>;
        Relationships: [];
      };
      segment_runs: {
        Row: SegmentRun;
        Insert: Partial<Omit<SegmentRun, "client_id" | "playbook_id" | "segment_id">> & {
          client_id: string;
          playbook_id: string;
          segment_id: string;
        };
        Update: Partial<SegmentRun>;
        Relationships: [];
      };
      proposals: {
        Row: Proposal;
        Insert: Partial<Omit<Proposal, "lead_id" | "html_content" | "subject">> & {
          lead_id: string;
          html_content: string;
          subject: string;
        };
        Update: Partial<Proposal>;
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
export type UserRole = "admin" | "sales_user" | "client_owner";

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

export type ClientEmailConfigStatus = "unverified" | "verified" | "paused";

export type ClientEmailDnsRecord = {
  /** Resend's record kind: "TXT", "MX", "CNAME". */
  record: string;
  name: string;
  type: string;
  ttl?: string;
  status?: string;
  value: string;
  priority?: number;
};

export type ClientEmailConfig = {
  from_email: string;
  reply_to: string;
  resend_domain_id: string | null;
  status: ClientEmailConfigStatus;
  verified_at?: string | null;
  dns_records?: ClientEmailDnsRecord[];
  /** Free-text — surfaced on the admin page when verification last failed. */
  last_error?: string | null;
};

/** Per-client calendar booking config. Today only Cal.com; future
 *  providers (Calendly, Google Calendar direct) drop in via the
 *  `provider` discriminator. */
export type ClientCalendarConfig = {
  provider: "cal_com";
  /** Svix-style signing secret for the booking webhook. */
  webhook_secret?: string | null;
  /** Per-team-member Cal.com event-type links. The agent picks one
   *  based on the playbook's assigned team_member for the lead. */
  team_member_links: Array<{
    team_member_id: string;
    /** "you/30min" — the path under cal.com (no scheme/host). */
    cal_link: string;
    event_type?: string;
  }>;
};

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
  /** Per-client Resend sending config. NULL until configured. When
   *  status !== "verified" the send loops fall back to the global env
   *  vars (RESEND_FROM_EMAIL) and log a warning. */
  email_config: ClientEmailConfig | null;
  /** Per-client booking config (Cal.com). NULL until configured —
   *  agents fall back to the deferred-handoff "human" stage when no
   *  booking link is available. */
  calendar_config: ClientCalendarConfig | null;
  notes: string | null;
  created_at: string;
};

export type AppUser = {
  id: string;
  full_name: string | null;
  email: string | null;
  role: UserRole;
  /** Per-user RLS scopes. Empty for admins (who see everything).
   *  Populated for client_owner / sales_user users to whitelist the
   *  client_ids they can read/write. */
  client_ids: string[];
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
  /** Cal.com booking uid — set on bookings created via webhook. */
  cal_booking_id: string | null;
  /** Direct URL for the lead to reschedule/cancel. */
  cal_booking_url: string | null;
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
  | "playbook_approval"
  | "reply_review"
  | "segment_proposal"
  | "deal_cold";

/** Payload for type='reply_review' approvals — drafted by the inbound
 *  classifier from the playbook's reply_strategy template + the lead's
 *  actual reply. HOS edits + sends from the approval card. */
export type ReplyReviewPayload = {
  lead_id: string;
  /** ReplyKind from the playbook (interested/not_now/wrong_person/objection). */
  reply_kind: ReplyKind;
  /** The inbound text we're replying to — for context in the card. */
  incoming_subject: string | null;
  incoming_excerpt: string;
  drafted_subject: string;
  drafted_body: string;
  /** When this is a positive-intent reply we embed the Cal.com booking
   *  link in the body. Surfaced separately so the card can render a
   *  "booking link included" indicator. */
  booking_link?: string | null;
  ai_warning?: string | null;
};

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

/** Per-provider params produced by the Claude-powered ICP translator —
 *  the exact shapes each downstream API expects. Cached on the playbook
 *  row so we only re-run Claude when the playbook version changes. */
export type TranslatedApolloParams = {
  /** `person_titles[]` — expanded variants (e.g. "Head of Operations" →
   *  ["Head of Operations", "VP Operations", "Director of Operations",
   *  "COO", "Operations Manager"]). */
  person_titles?: string[];
  /** Apollo enum: owner | founder | c_suite | partner | vp | head |
   *  director | manager | senior | entry | intern. */
  person_seniorities?: string[];
  /** Cities, US states, countries — Apollo `person_locations[]`. */
  person_locations?: string[];
  /** Comma-separated min,max strings — Apollo expects exactly this format
   *  e.g. ["20,200"]. */
  organization_num_employees_ranges?: string[];
  /** Free-text industry keywords. Apollo's `q_organization_industry_keywords`
   *  is undocumented on People Search but observed to filter in practice. */
  q_organization_industry_keywords?: string[];
  /** Free-text keyword filter — Apollo `q_keywords`. */
  q_keywords?: string;
  /** Set false when we've already expanded titles; default true otherwise. */
  include_similar_titles?: boolean;
};

export type TranslatedHunterParams = {
  /** Case-insensitive substring filter applied after Hunter returns a
   *  candidate — used to reject contacts whose title doesn't match. */
  title_keywords?: string[];
};

export type TranslatedParams = {
  /** Playbook version this translation was generated for. */
  version: number;
  apollo: TranslatedApolloParams;
  hunter: TranslatedHunterParams;
  /** Claude's notes on what it inferred / expanded. */
  notes?: string;
  /** Set when Claude was unavailable and the deterministic fallback was used. */
  warning?: string | null;
  created_at: string;
};

export type ICP = {
  industries?: string[];
  company_size?: string;
  target_titles?: string[];
  geography?: string[];
  qualification_signal?: string;
  disqualifiers?: string[];
  /** Set by lib/icp-translator.ts when Prospect-01 first runs. Regenerated
   *  whenever playbook.version changes. */
  translated_params?: TranslatedParams;
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

/**
 * Item 7 — per-playbook market segments. Each segment is a focused
 * micro-ICP with its own value angle. Prospect-01 runs against ONE
 * segment per invocation, not against playbook.icp. Whole-playbook
 * approval is intentionally NOT gated on segments being decided — that
 * gate activates after client 3. Until then, the 5 playbook sections
 * gate approval and segments are reviewed independently.
 */
export type PlaybookSegmentStatus =
  | "pending_approval"
  | "active"
  | "exhausted"
  | "rejected";

export type PlaybookSegment = {
  /** Stable per-playbook id (e.g. "seg_001") — used by segment_runs. */
  id: string;
  name: string;
  description: string;
  /** Segment-scoped ICP. Translated by lib/icp-translator.ts on first run
   *  and cached on the segment itself (translated_params on the ICP). */
  icp: ICP;
  /** Distinct pitch for this segment — Outreach-01 + Sales-01 weave this
   *  into their drafts so messaging stays segment-specific. */
  value_angle: string;
  estimated_pool_size: number;
  status: PlaybookSegmentStatus;
  /** 0-100, updated by Learning-01. null until enough signal to score. */
  performance_score: number | null;
  runs_completed: number;
  leads_remaining: number;
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
  /** Item 7 — segment library. Empty array on playbooks generated before
   *  the segment-aware onboarding rolled out. */
  segments?: PlaybookSegment[];
  /** Item 8 — Close-01 reads this when drafting proposals. When null/
   *  undefined the proposal goes out without a Stripe payment link and
   *  HOS follows up manually. TS-only today; no DB column required since
   *  it's read from the JSON payload. */
  pricing_cents?: number | null;
  notes: string | null;
  created_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * One Prospect-01 invocation against a specific segment. Powers the
 * "Run N of M (X leads left)" counter on the Run Prospect-01 dropdown +
 * Learning-01's per-segment performance scoring.
 */
export type SegmentRun = {
  id: string;
  client_id: string;
  playbook_id: string;
  segment_id: string;
  leads_sourced: number;
  leads_remaining: number | null;
  performance_score: number | null;
  ran_at: string;
  ran_by: string | null;
};

/**
 * Payload shape for type='segment_proposal' approvals — Learning-01
 * generates one when a segment is exhausted, scoring high, or 30+ days
 * since last proposal. HOS approves to add it to playbook.segments[].
 */
export type SegmentProposalPayload = {
  segment: PlaybookSegment;
  reason: "segment_exhausted" | "high_performer" | "periodic_refresh" | "manual";
  evidence: string;
  predicted_impact?: string | null;
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

/** The reviewable playbook sections in order. The contact approves
 *  each one independently before the playbook is written. Item 7 added
 *  "segments" between icp and strategy — informational today (advancing
 *  is not gated on every segment being decided) but the per-segment
 *  approve/reject state writes through to playbooks.segments[].status. */
export type OnboardingSectionId =
  | "icp"
  | "segments"
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
  /** Item 7 — segment library. Optional on existing drafts; required
   *  going forward via the extended onboarding prompt. */
  segments?: PlaybookSegment[];
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

// ── Suppression list ──────────────────────────────────────────────────────

export type SuppressedEmailReason =
  | "unsubscribe"
  | "bounce"
  | "complaint"
  | "manual";

export type SuppressedEmail = {
  email: string;
  reason: SuppressedEmailReason;
  source_lead_id: string | null;
  source_client_id: string | null;
  notes: string | null;
  unsubscribe_token: string;
  suppressed_at: string;
};

// ── Usage events ──────────────────────────────────────────────────────────

export type UsageEvent = {
  id: string;
  client_id: string | null;
  kind: string;
  units: number;
  cost_cents: number;
  payload: Json;
  occurred_at: string;
};

// ── Proposals (Item 8 — Close-01) ────────────────────────────────────────

export type ProposalStatus =
  | "draft"
  | "sent"
  | "viewed"
  | "accepted"
  | "paid"
  | "expired"
  | "rejected";

/**
 * Item 8 — HTML proposal drafted by Close-01 after a successful meeting.
 * Replaces the email-only proposal_review flow for new leads (existing
 * proposal_review approvals continue to work). The lead opens
 * /p/[token] to view + accept; when amount_cents is set, accepting
 * triggers a Stripe Payment Link.
 */
export type Proposal = {
  id: string;
  token: string;
  client_id: string | null;
  lead_id: string;
  meeting_id: string | null;
  meeting_note_id: string | null;
  html_content: string;
  subject: string;
  status: ProposalStatus;
  stripe_payment_link_id: string | null;
  stripe_payment_link_url: string | null;
  amount_cents: number | null;
  currency: string | null;
  view_count: number;
  viewed_at: string | null;
  accepted_at: string | null;
  paid_at: string | null;
  expires_at: string | null;
  followup_sent_at: string | null;
  cold_flagged_at: string | null;
  created_by: string | null;
  created_at: string;
};

/**
 * Payload shape for type='deal_cold' approvals — Close-01 opens these
 * when a proposal sat at status='sent' with no open for 48h, or at
 * status='viewed' with no accept for 5 days. HOS sees the lead + the
 * proposal link + the cold reason and chooses to manually nudge the
 * lead, mark the lead lost, or close out the proposal.
 */
export type DealColdPayload = {
  proposal_id: string;
  lead_id: string;
  /** Why we flagged it cold. */
  reason: "no_view_48h" | "no_accept_5d" | "manual";
  /** Echoed for the approval card so HOS doesn't need to click through. */
  lead_name: string;
  proposal_subject: string;
  proposal_url: string;
  amount_cents: number | null;
  /** Hours / days since the relevant timestamp (sent_at or viewed_at). */
  staleness_hours: number;
};
