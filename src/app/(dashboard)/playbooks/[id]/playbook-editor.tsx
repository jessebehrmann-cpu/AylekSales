"use client";

import { useState, useTransition, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert } from "@/components/ui/alert";
import {
  ArrowDown,
  ArrowUp,
  GripVertical,
  Plus,
  Save,
  Send,
  Sparkles,
  Trash2,
  Workflow,
  Target,
  MessageSquare,
  Mic,
  Reply,
  Users,
  Mail,
  ListTree,
} from "lucide-react";
import {
  regenerateSequenceForPlaybook,
  saveDraftPlaybook,
  submitPlaybookForApproval,
} from "../actions";
import type {
  ChannelFlags,
  EscalationRule,
  ICP,
  Playbook,
  PlaybookSequenceStep,
  PlaybookVersion,
  ReplyKind,
  ReplyStrategy,
  SalesProcessStage,
  Strategy,
  TeamMember,
  VoiceTone,
} from "@/lib/supabase/types";
import { DEFAULT_SALES_PROCESS, KNOWN_AGENTS } from "@/lib/playbook-defaults";

type EditorPlaybook = Playbook & { clients: { name: string } | null };
type VersionRow = Pick<PlaybookVersion, "id" | "version" | "status" | "created_at" | "change_reason">;

type TabKey =
  | "sales_process"
  | "icp"
  | "strategy"
  | "voice"
  | "reply"
  | "team"
  | "sequence";

const TABS: Array<{ key: TabKey; label: string; icon: typeof Workflow }> = [
  { key: "sales_process", label: "Sales Process", icon: Workflow },
  { key: "icp", label: "ICP", icon: Target },
  { key: "strategy", label: "Strategy & Messaging", icon: MessageSquare },
  { key: "voice", label: "Voice & Tone", icon: Mic },
  { key: "reply", label: "Reply Strategy", icon: Reply },
  { key: "team", label: "Team Members", icon: Users },
  { key: "sequence", label: "Email Sequence", icon: Mail },
];

const REPLY_KINDS: Array<{ key: ReplyKind; label: string; hint: string }> = [
  { key: "interested", label: "Interested", hint: "They want to learn more or book time." },
  { key: "not_now", label: "Not now", hint: "Wrong timing, try again later." },
  { key: "wrong_person", label: "Wrong person", hint: "Re-routes to a colleague." },
  { key: "unsubscribe", label: "Unsubscribe / opt-out", hint: "Hard stop, no further outreach." },
  { key: "objection", label: "Objection", hint: "Pushback we should address." },
];

// Dark-theme tokens shared across the editor
const DARK = {
  bg: "bg-[#080810]",
  panel: "bg-[#0e0e18]",
  panelBorder: "border-[#1e1e2e]",
  input: "border-[#262636] bg-[#14141f]",
  inputText: "text-[#eeeef5]",
  inputPlaceholder: "placeholder:text-[#52526e]",
  faint: "text-[#52526e]",
  body: "text-[#b0b0c8]",
  text: "text-[#eeeef5]",
  accent: "text-[#00e5a0]",
  accentBg: "bg-[#00e5a0]",
  accentSoft: "bg-[rgba(0,229,160,0.08)] border-[rgba(0,229,160,0.2)]",
  accentSofter: "bg-[rgba(0,229,160,0.15)]",
};

export function PlaybookEditor({
  playbook,
  versions,
}: {
  playbook: EditorPlaybook;
  versions: VersionRow[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [aiPending, setAiPending] = useState(false);
  const [aiWarning, setAiWarning] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("sales_process");

  const readOnly = playbook.status !== "draft";

  const [icp, setIcp] = useState<ICP>(playbook.icp ?? {});
  const [steps, setSteps] = useState<PlaybookSequenceStep[]>(
    Array.isArray(playbook.sequences) ? playbook.sequences : [],
  );
  const [escalations, setEscalations] = useState<EscalationRule[]>(
    Array.isArray(playbook.escalation_rules) ? playbook.escalation_rules : [],
  );
  const [channels, setChannels] = useState<ChannelFlags>(
    playbook.channel_flags ?? { email: true, phone: false, linkedin: false },
  );
  const [strategy, setStrategy] = useState<Strategy>(playbook.strategy ?? {});
  const [voice, setVoice] = useState<VoiceTone>(playbook.voice_tone ?? {});
  const [reply, setReply] = useState<ReplyStrategy>(playbook.reply_strategy ?? {});
  const [team, setTeam] = useState<TeamMember[]>(
    Array.isArray(playbook.team_members) ? playbook.team_members : [],
  );
  const [salesProcess, setSalesProcess] = useState<SalesProcessStage[]>(
    Array.isArray(playbook.sales_process) && playbook.sales_process.length > 0
      ? playbook.sales_process
      : DEFAULT_SALES_PROCESS,
  );
  const [notes, setNotes] = useState<string>(playbook.notes ?? "");

  const dirty = useMemo(() => {
    const a = JSON.stringify({
      icp: playbook.icp,
      sequences: playbook.sequences,
      escalation_rules: playbook.escalation_rules,
      channel_flags: playbook.channel_flags,
      strategy: playbook.strategy,
      voice_tone: playbook.voice_tone,
      reply_strategy: playbook.reply_strategy,
      team_members: playbook.team_members,
      sales_process: playbook.sales_process,
      notes: playbook.notes,
    });
    const b = JSON.stringify({
      icp,
      sequences: steps,
      escalation_rules: escalations,
      channel_flags: channels,
      strategy,
      voice_tone: voice,
      reply_strategy: reply,
      team_members: team,
      sales_process: salesProcess,
      notes,
    });
    return a !== b;
  }, [playbook, icp, steps, escalations, channels, strategy, voice, reply, team, salesProcess, notes]);

  const strategyOrVoiceDirty = useMemo(
    () =>
      JSON.stringify(playbook.strategy ?? {}) !== JSON.stringify(strategy) ||
      JSON.stringify(playbook.voice_tone ?? {}) !== JSON.stringify(voice),
    [playbook.strategy, playbook.voice_tone, strategy, voice],
  );
  const hasStrategyOrVoiceContent =
    Object.keys(strategy ?? {}).length > 0 || Object.keys(voice ?? {}).length > 0;

  function fullPayload() {
    return {
      id: playbook.id,
      icp,
      sequences: steps,
      escalation_rules: escalations,
      channel_flags: channels,
      strategy,
      voice_tone: voice,
      reply_strategy: reply,
      team_members: team,
      sales_process: salesProcess,
      notes,
    };
  }

  function onSave() {
    setError(null);
    setSaved(false);
    start(async () => {
      const r = await saveDraftPlaybook(fullPayload());
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  function onSubmit() {
    if (steps.length === 0) {
      setError("Add at least one sequence step before submitting.");
      setTab("sequence");
      return;
    }
    if (!confirm("Submit this playbook for approval? It will be locked until approved or rejected.")) return;
    setError(null);
    start(async () => {
      if (dirty) {
        const r1 = await saveDraftPlaybook(fullPayload());
        if (!r1.ok) {
          setError(r1.error);
          return;
        }
      }
      const r = await submitPlaybookForApproval(playbook.id);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.push("/approvals");
      router.refresh();
    });
  }

  function onRegenerate() {
    setError(null);
    setAiWarning(null);
    setAiPending(true);
    start(async () => {
      if (dirty) {
        const r1 = await saveDraftPlaybook(fullPayload());
        if (!r1.ok) {
          setError(r1.error);
          setAiPending(false);
          return;
        }
      }
      const r = await regenerateSequenceForPlaybook(playbook.id);
      setAiPending(false);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setSteps(r.steps);
      if (r.source === "placeholder" && r.warning) setAiWarning(r.warning);
      router.refresh();
    });
  }

  return (
    <div className={`-m-6 min-h-[calc(100vh-4rem)] ${DARK.bg} ${DARK.text}`}>
      {/* Top header */}
      <div className={`flex flex-wrap items-center justify-between gap-3 border-b ${DARK.panelBorder} px-6 py-4`}>
        <div className="flex items-baseline gap-3">
          <p className={`text-xs uppercase tracking-wider ${DARK.faint}`}>
            {playbook.clients?.name ?? "Client"} · Playbook
          </p>
          <h1 className="font-['Epilogue',sans-serif] text-2xl font-bold tracking-tight">
            v{playbook.version}
          </h1>
          <StatusPill status={playbook.status} />
        </div>
        <div className="flex items-center gap-2">
          {!readOnly && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={onSave}
                disabled={pending || !dirty}
                className={`${DARK.input} ${DARK.body} hover:bg-[#1a1a28]`}
              >
                <Save className="mr-1 h-3 w-3" />
                {pending ? "Saving…" : "Save draft"}
              </Button>
              <Button
                size="sm"
                onClick={onSubmit}
                disabled={pending}
                className={`${DARK.accentBg} text-black hover:bg-[#00e5a0]/90`}
              >
                <Send className="mr-1 h-3 w-3" />
                Submit for approval
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Status banners */}
      <div className="space-y-2 px-6 pt-4">
        {readOnly && (
          <Alert className="border-amber-500/30 bg-amber-500/5 text-amber-300">
            {playbook.status === "approved"
              ? "This playbook is approved and locked. To make changes, create a new draft and submit it for approval."
              : "This playbook is awaiting HOS approval. Reject it to return to draft."}
          </Alert>
        )}
        {error && <Alert variant="destructive">{error}</Alert>}
        {saved && !error && <Alert variant="success">Saved.</Alert>}
        {aiWarning && (
          <Alert className="border-amber-500/30 bg-amber-500/5 text-amber-300">
            <strong>{aiWarning}</strong> A placeholder sequence was used — edit the steps and try again once the API key is set.
          </Alert>
        )}
      </div>

      {/* Two-column body: left tabs, right pane */}
      <div className="flex gap-6 px-6 pb-10 pt-4">
        <aside className="w-56 shrink-0">
          <nav className="space-y-1">
            {TABS.map(({ key, label, icon: Icon }) => {
              const active = tab === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTab(key)}
                  className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors ${
                    active
                      ? `${DARK.accentSofter} ${DARK.accent}`
                      : `${DARK.body} hover:bg-[#14141f]`
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  <span className="flex-1">{label}</span>
                </button>
              );
            })}
          </nav>

          {versions.length > 0 && (
            <div className="mt-8">
              <p className={`mb-2 text-[10px] font-semibold uppercase tracking-[0.15em] ${DARK.faint}`}>
                <ListTree className="mr-1 inline h-3 w-3" /> Version history
              </p>
              <ul className={`divide-y ${DARK.panelBorder} text-xs ${DARK.body}`}>
                {versions.slice(0, 5).map((v) => (
                  <li key={v.id} className="flex items-center justify-between py-1.5">
                    <span>v{v.version}</span>
                    <span className={DARK.faint}>{v.status}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>

        <main className="flex-1 min-w-0">
          {tab === "sales_process" && (
            <SalesProcessSection
              stages={salesProcess}
              onChange={setSalesProcess}
              readOnly={readOnly}
            />
          )}
          {tab === "icp" && <IcpSection icp={icp} setIcp={setIcp} readOnly={readOnly} />}
          {tab === "strategy" && (
            <StrategySection strategy={strategy} setStrategy={setStrategy} readOnly={readOnly} />
          )}
          {tab === "voice" && (
            <VoiceSection voice={voice} setVoice={setVoice} readOnly={readOnly} />
          )}
          {tab === "reply" && <ReplySection reply={reply} setReply={setReply} readOnly={readOnly} />}
          {tab === "team" && (
            <TeamSection team={team} setTeam={setTeam} readOnly={readOnly} steps={steps} setSteps={setSteps} />
          )}
          {tab === "sequence" && (
            <SequenceSection
              steps={steps}
              setSteps={setSteps}
              escalations={escalations}
              setEscalations={setEscalations}
              channels={channels}
              setChannels={setChannels}
              team={team}
              readOnly={readOnly}
              onRegenerate={onRegenerate}
              regenerateDisabled={pending || aiPending}
              regenerateLabel={
                aiPending
                  ? "Regenerating…"
                  : strategyOrVoiceDirty
                  ? "Regenerate sequence (uses unsaved Strategy + Voice)"
                  : "Regenerate sequence"
              }
              hasStrategyOrVoiceContent={hasStrategyOrVoiceContent}
              notes={notes}
              setNotes={setNotes}
            />
          )}
        </main>
      </div>
    </div>
  );
}

// ─── Sections ────────────────────────────────────────────────────────────────

function SalesProcessSection({
  stages,
  onChange,
  readOnly,
}: {
  stages: SalesProcessStage[];
  onChange: (next: SalesProcessStage[]) => void;
  readOnly: boolean;
}) {
  return (
    <SectionShell
      label="Sales Process"
      blurb="Ordered list of stages that this client's sales process follows. Agents read this to know what stage they're operating in and what comes next."
      right={
        !readOnly && (
          <div className="flex gap-2">
            {stages.length === 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onChange(DEFAULT_SALES_PROCESS)}
                className={`${DARK.input} ${DARK.body} hover:bg-[#1a1a28]`}
              >
                Use default stages
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                onChange([
                  ...stages,
                  { id: cryptoId(), name: "", description: "", agent: "" },
                ])
              }
              className={`${DARK.input} ${DARK.body} hover:bg-[#1a1a28]`}
            >
              <Plus className="mr-1 h-3 w-3" /> Add stage
            </Button>
          </div>
        )
      }
    >
      {stages.length === 0 ? (
        <EmptyPanel>No stages yet. Click &quot;Use default stages&quot; to start, or add your own.</EmptyPanel>
      ) : (
        <div className="space-y-2">
          {stages.map((s, idx) => (
            <div key={s.id ?? idx} className={`flex items-start gap-3 rounded-xl border ${DARK.panelBorder} ${DARK.panel} p-4`}>
              <div className="flex flex-col items-center gap-1 pt-1">
                <div className={`flex h-7 w-7 items-center justify-center rounded-full border ${DARK.accentSoft} text-xs font-bold ${DARK.accent}`}>
                  {idx + 1}
                </div>
                {!readOnly && (
                  <>
                    <button
                      type="button"
                      onClick={() => onChange(reorder(stages, idx, -1))}
                      disabled={idx === 0}
                      className={`${DARK.faint} hover:text-[#b0b0c8] disabled:opacity-30`}
                    >
                      <ArrowUp className="h-3 w-3" />
                    </button>
                    <GripVertical className="h-3 w-3 text-[#3a3a52]" />
                    <button
                      type="button"
                      onClick={() => onChange(reorder(stages, idx, +1))}
                      disabled={idx === stages.length - 1}
                      className={`${DARK.faint} hover:text-[#b0b0c8] disabled:opacity-30`}
                    >
                      <ArrowDown className="h-3 w-3" />
                    </button>
                  </>
                )}
              </div>
              <div className="grid flex-1 gap-2 md:grid-cols-[1fr,1fr]">
                <Input
                  value={s.name}
                  readOnly={readOnly}
                  onChange={(e) => onChange(stages.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x)))}
                  placeholder="Stage name (e.g. Book meeting)"
                  className={`${DARK.input} text-sm ${DARK.inputText} ${DARK.inputPlaceholder}`}
                />
                <AgentInput
                  value={s.agent}
                  readOnly={readOnly}
                  onChange={(v) => onChange(stages.map((x, i) => (i === idx ? { ...x, agent: v } : x)))}
                />
                <Textarea
                  value={s.description}
                  readOnly={readOnly}
                  rows={2}
                  onChange={(e) => onChange(stages.map((x, i) => (i === idx ? { ...x, description: e.target.value } : x)))}
                  placeholder="What happens at this stage"
                  className={`${DARK.input} md:col-span-2 text-sm ${DARK.body} ${DARK.inputPlaceholder}`}
                />
              </div>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => onChange(stages.filter((_, i) => i !== idx))}
                  className={`${DARK.faint} hover:text-red-400`}
                  title="Remove stage"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </SectionShell>
  );
}

function IcpSection({
  icp,
  setIcp,
  readOnly,
}: {
  icp: ICP;
  setIcp: (v: ICP) => void;
  readOnly: boolean;
}) {
  return (
    <SectionShell
      label="Ideal Customer Profile"
      blurb="The buyer profile this playbook targets. Used by Prospect-01 to source leads and by the qualification agent to filter inbound."
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        <ICPField label="Industries" value={icp.industries?.join(", ") ?? ""} onChange={(v) => setIcp({ ...icp, industries: splitList(v) })} readOnly={readOnly} placeholder="e.g. SaaS, Logistics, Construction" />
        <ICPField label="Company Size" value={icp.company_size ?? ""} onChange={(v) => setIcp({ ...icp, company_size: v })} readOnly={readOnly} placeholder="20–500 employees" />
        <ICPField label="Target Titles" value={icp.target_titles?.join(", ") ?? ""} onChange={(v) => setIcp({ ...icp, target_titles: splitList(v) })} readOnly={readOnly} placeholder="Head of Ops, VP Sales" />
        <ICPField label="Geography" value={icp.geography?.join(", ") ?? ""} onChange={(v) => setIcp({ ...icp, geography: splitList(v) })} readOnly={readOnly} placeholder="ANZ, North America" />
        <ICPField label="Qualification Signal" value={icp.qualification_signal ?? ""} onChange={(v) => setIcp({ ...icp, qualification_signal: v })} readOnly={readOnly} placeholder="e.g. Series B+, multi-region team" />
        <ICPField label="Disqualifiers" value={icp.disqualifiers?.join(", ") ?? ""} onChange={(v) => setIcp({ ...icp, disqualifiers: splitList(v) })} readOnly={readOnly} placeholder="Government, under 10 staff" />
      </div>
    </SectionShell>
  );
}

function StrategySection({
  strategy,
  setStrategy,
  readOnly,
}: {
  strategy: Strategy;
  setStrategy: (v: Strategy) => void;
  readOnly: boolean;
}) {
  return (
    <SectionShell
      label="Strategy & Messaging"
      blurb="The buyer-facing positioning. Drives sequence regeneration when present."
    >
      <div className="space-y-4">
        <FieldGroup label="Value proposition">
          <Textarea
            value={strategy.value_proposition ?? ""}
            readOnly={readOnly}
            rows={2}
            onChange={(e) => setStrategy({ ...strategy, value_proposition: e.target.value })}
            placeholder="One sentence — the buyer-facing version of why we exist."
            className={`${DARK.input} text-sm ${DARK.inputText} ${DARK.inputPlaceholder}`}
          />
        </FieldGroup>
        <ListField label="Key messages" values={strategy.key_messages ?? []} onChange={(arr) => setStrategy({ ...strategy, key_messages: arr })} readOnly={readOnly} placeholder="Add a key message" />
        <ListField label="Proof points" values={strategy.proof_points ?? []} onChange={(arr) => setStrategy({ ...strategy, proof_points: arr })} readOnly={readOnly} placeholder="Add a metric, case study, or quote" />
        <ObjectionField responses={strategy.objection_responses ?? []} onChange={(arr) => setStrategy({ ...strategy, objection_responses: arr })} readOnly={readOnly} />
      </div>
    </SectionShell>
  );
}

function VoiceSection({
  voice,
  setVoice,
  readOnly,
}: {
  voice: VoiceTone;
  setVoice: (v: VoiceTone) => void;
  readOnly: boolean;
}) {
  return (
    <SectionShell
      label="Voice & Tone"
      blurb="How the brand sounds. Anchors every email Claude writes."
    >
      <div className="space-y-4">
        <ListField label="Tone descriptors" values={voice.tone_descriptors ?? []} onChange={(arr) => setVoice({ ...voice, tone_descriptors: arr })} readOnly={readOnly} placeholder="e.g. direct, warm, dry-witted" />
        <FieldGroup label="Writing style">
          <Textarea
            value={voice.writing_style ?? ""}
            readOnly={readOnly}
            rows={3}
            onChange={(e) => setVoice({ ...voice, writing_style: e.target.value })}
            placeholder="Sentence length, contractions, lowercase opening lines, etc."
            className={`${DARK.input} text-sm ${DARK.inputText} ${DARK.inputPlaceholder}`}
          />
        </FieldGroup>
        <ListField label="What to avoid" values={voice.avoid ?? []} onChange={(arr) => setVoice({ ...voice, avoid: arr })} readOnly={readOnly} placeholder="e.g. corporate speak, exclamation marks" />
        <ListField label="Example phrases" values={voice.example_phrases ?? []} onChange={(arr) => setVoice({ ...voice, example_phrases: arr })} readOnly={readOnly} placeholder="A line that sounds like us" />
      </div>
    </SectionShell>
  );
}

function ReplySection({
  reply,
  setReply,
  readOnly,
}: {
  reply: ReplyStrategy;
  setReply: (v: ReplyStrategy) => void;
  readOnly: boolean;
}) {
  return (
    <SectionShell
      label="Reply Strategy"
      blurb="How each kind of reply is handled. The action runs automatically; the template is the auto-reply body (leave blank for none)."
    >
      <div className="space-y-3">
        {REPLY_KINDS.map(({ key, label, hint }) => {
          const r = reply[key] ?? {};
          return (
            <div key={key} className={`rounded-xl border ${DARK.panelBorder} ${DARK.panel} p-4`}>
              <div className="mb-2 flex items-baseline justify-between">
                <p className={`text-sm font-semibold ${DARK.text}`}>{label}</p>
                <p className={`text-[10px] uppercase tracking-wider ${DARK.faint}`}>{hint}</p>
              </div>
              <Input
                value={r.action ?? ""}
                readOnly={readOnly}
                onChange={(e) => setReply({ ...reply, [key]: { ...r, action: e.target.value } })}
                placeholder="Action — e.g. book meeting, mark unsubscribed, snooze 90 days"
                className={`mb-2 ${DARK.input} text-sm ${DARK.inputText} ${DARK.inputPlaceholder}`}
              />
              <Textarea
                value={r.template ?? ""}
                readOnly={readOnly}
                rows={2}
                onChange={(e) => setReply({ ...reply, [key]: { ...r, template: e.target.value } })}
                placeholder="Reply template — leave blank if no auto-reply for this kind."
                className={`${DARK.input} text-sm ${DARK.body} ${DARK.inputPlaceholder}`}
              />
            </div>
          );
        })}
      </div>
    </SectionShell>
  );
}

function TeamSection({
  team,
  setTeam,
  readOnly,
  steps,
  setSteps,
}: {
  team: TeamMember[];
  setTeam: (v: TeamMember[]) => void;
  readOnly: boolean;
  steps: PlaybookSequenceStep[];
  setSteps: (v: PlaybookSequenceStep[]) => void;
}) {
  return (
    <SectionShell
      label="Team Members"
      blurb="The people who can show up as the From: name on a sequence step. The first member is the default sender."
      right={
        !readOnly && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setTeam([...team, { id: cryptoId(), name: "", title: "", email: "" }])}
            className={`${DARK.input} ${DARK.body} hover:bg-[#1a1a28]`}
          >
            <Plus className="mr-1 h-3 w-3" /> Add member
          </Button>
        )
      }
    >
      {team.length === 0 ? (
        <EmptyPanel>
          No team members yet. Add at least one — the first member is the default sender on every step.
        </EmptyPanel>
      ) : (
        <div className="space-y-2">
          {team.map((m, idx) => (
            <div
              key={m.id}
              className={`grid grid-cols-1 gap-2 rounded-xl border ${DARK.panelBorder} ${DARK.panel} p-3 md:grid-cols-[1fr,1fr,1.5fr,auto]`}
            >
              <Input
                value={m.name}
                readOnly={readOnly}
                onChange={(e) => setTeam(team.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x)))}
                placeholder="Name (e.g. Jesse Behrmann)"
                className={`${DARK.input} text-sm ${DARK.inputText} ${DARK.inputPlaceholder}`}
              />
              <Input
                value={m.title}
                readOnly={readOnly}
                onChange={(e) => setTeam(team.map((x, i) => (i === idx ? { ...x, title: e.target.value } : x)))}
                placeholder="Title (e.g. CEO)"
                className={`${DARK.input} text-sm ${DARK.inputText} ${DARK.inputPlaceholder}`}
              />
              <Input
                type="email"
                value={m.email}
                readOnly={readOnly}
                onChange={(e) => setTeam(team.map((x, i) => (i === idx ? { ...x, email: e.target.value } : x)))}
                placeholder="email@company.com"
                className={`${DARK.input} text-sm ${DARK.inputText} ${DARK.inputPlaceholder}`}
              />
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => {
                    setTeam(team.filter((_, i) => i !== idx));
                    // Any step pointing at this index is reset.
                    setSteps(steps.map((s) => ({ ...s, sender_index: s.sender_index === idx ? null : s.sender_index })));
                  }}
                  className={`${DARK.faint} hover:text-red-400`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </SectionShell>
  );
}

function SequenceSection({
  steps,
  setSteps,
  escalations,
  setEscalations,
  channels,
  setChannels,
  team,
  readOnly,
  onRegenerate,
  regenerateDisabled,
  regenerateLabel,
  hasStrategyOrVoiceContent,
  notes,
  setNotes,
}: {
  steps: PlaybookSequenceStep[];
  setSteps: (v: PlaybookSequenceStep[]) => void;
  escalations: EscalationRule[];
  setEscalations: (v: EscalationRule[]) => void;
  channels: ChannelFlags;
  setChannels: (v: ChannelFlags) => void;
  team: TeamMember[];
  readOnly: boolean;
  onRegenerate: () => void;
  regenerateDisabled: boolean;
  regenerateLabel: string;
  hasStrategyOrVoiceContent: boolean;
  notes: string;
  setNotes: (v: string) => void;
}) {
  return (
    <SectionShell
      label="Email Sequence"
      blurb="The outbound steps. Each step has a sender (from Team Members) and a delay in days from the previous step."
      right={
        <div className="flex items-center gap-2">
          {!readOnly && hasStrategyOrVoiceContent && (
            <Button
              size="sm"
              onClick={onRegenerate}
              disabled={regenerateDisabled}
              className={`${DARK.accentSofter} ${DARK.accent} hover:bg-[rgba(0,229,160,0.25)]`}
              title={regenerateLabel}
            >
              <Sparkles className="mr-1 h-3 w-3" />
              {regenerateLabel}
            </Button>
          )}
          {!readOnly && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setSteps([
                  ...steps,
                  {
                    step: steps.length + 1,
                    subject: "",
                    body: "",
                    delay_days: steps.length === 0 ? 0 : 3,
                    sender_index: team.length > 0 ? 0 : null,
                  },
                ])
              }
              className={`${DARK.input} ${DARK.body} hover:bg-[#1a1a28]`}
            >
              <Plus className="mr-1 h-3 w-3" /> Add step
            </Button>
          )}
        </div>
      }
    >
      {steps.length === 0 ? (
        <EmptyPanel>
          No sequence steps yet.
          {hasStrategyOrVoiceContent && " Click Regenerate sequence to draft one from your strategy + voice."}
        </EmptyPanel>
      ) : (
        <div className="space-y-2">
          {steps.map((s, idx) => (
            <div key={idx} className={`flex items-start gap-3 rounded-xl border ${DARK.panelBorder} ${DARK.panel} p-4`}>
              <div className="flex flex-col items-center gap-1 pt-1">
                <div className={`flex h-7 w-7 items-center justify-center rounded-full border ${DARK.accentSoft} text-xs font-bold ${DARK.accent}`}>
                  {idx + 1}
                </div>
                {!readOnly && (
                  <>
                    <button type="button" onClick={() => setSteps(reorderSteps(steps, idx, -1))}
                      disabled={idx === 0} className={`${DARK.faint} hover:text-[#b0b0c8] disabled:opacity-30`}>
                      <ArrowUp className="h-3 w-3" />
                    </button>
                    <GripVertical className="h-3 w-3 text-[#3a3a52]" />
                    <button type="button" onClick={() => setSteps(reorderSteps(steps, idx, +1))}
                      disabled={idx === steps.length - 1} className={`${DARK.faint} hover:text-[#b0b0c8] disabled:opacity-30`}>
                      <ArrowDown className="h-3 w-3" />
                    </button>
                  </>
                )}
              </div>
              <div className="flex-1 min-w-0 space-y-2">
                <Input
                  value={s.subject}
                  readOnly={readOnly}
                  onChange={(e) =>
                    setSteps(steps.map((x, i) => (i === idx ? { ...x, subject: e.target.value } : x)))
                  }
                  placeholder="Subject line"
                  className={`${DARK.input} text-sm ${DARK.inputText} ${DARK.inputPlaceholder}`}
                />
                <Textarea
                  value={s.body}
                  readOnly={readOnly}
                  rows={4}
                  onChange={(e) =>
                    setSteps(steps.map((x, i) => (i === idx ? { ...x, body: e.target.value } : x)))
                  }
                  placeholder="Body (use {{contact_name}} and {{company_name}})"
                  className={`${DARK.input} text-sm ${DARK.body} ${DARK.inputPlaceholder}`}
                />
                <div className={`flex flex-wrap items-center gap-3 text-xs ${DARK.faint}`}>
                  <label className="flex items-center gap-1.5">
                    Delay
                    <Input
                      type="number" min={0} max={60} value={s.delay_days} readOnly={readOnly}
                      onChange={(e) =>
                        setSteps(steps.map((x, i) =>
                          i === idx ? { ...x, delay_days: Number(e.target.value) || 0 } : x))
                      }
                      className={`h-7 w-16 ${DARK.input} px-1.5 text-xs ${DARK.inputText}`}
                    />
                    days
                  </label>
                  <label className="flex items-center gap-1.5">
                    Sender
                    <select
                      disabled={readOnly || team.length === 0}
                      value={s.sender_index ?? ""}
                      onChange={(e) =>
                        setSteps(steps.map((x, i) =>
                          i === idx ? { ...x, sender_index: e.target.value === "" ? null : Number(e.target.value) } : x))
                      }
                      className={`h-7 rounded ${DARK.input} px-2 text-xs ${DARK.inputText} disabled:opacity-50`}
                      title={team.length === 0 ? "Add team members first" : "Pick the sender for this step"}
                    >
                      <option value="">{team.length === 0 ? "no team yet" : "default (first member)"}</option>
                      {team.map((m, i) => (
                        <option key={m.id} value={i}>
                          {m.name || `Member ${i + 1}`}{m.title ? ` — ${m.title}` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => setSteps(steps.filter((_, i) => i !== idx).map((x, i) => ({ ...x, step: i + 1 })))}
                      className={`ml-auto inline-flex items-center gap-1 ${DARK.faint} hover:text-red-400`}
                    >
                      <Trash2 className="h-3 w-3" /> Remove
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SubSection label="Channels">
          <div className="flex gap-2">
            {(Object.keys(channels) as Array<keyof ChannelFlags>).map((k) => (
              <button
                key={k}
                type="button"
                disabled={readOnly || k !== "email"}
                onClick={() => setChannels({ ...channels, [k]: !channels[k] })}
                className={`rounded-full border px-3 py-1 text-xs capitalize transition-colors ${
                  channels[k] ? `border-[rgba(0,229,160,0.3)] ${DARK.accentSofter} ${DARK.accent}` : `${DARK.input} ${DARK.faint}`
                } ${k !== "email" ? "opacity-50" : ""}`}
                title={k !== "email" ? "Phone + LinkedIn channels coming soon" : ""}
              >
                {k}{k !== "email" && " (soon)"}
              </button>
            ))}
          </div>
        </SubSection>

        <SubSection
          label="Escalation"
          right={
            !readOnly && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEscalations([...escalations, { after_step: Math.max(1, steps.length), action: "notify" }])}
                className={`${DARK.input} ${DARK.body} hover:bg-[#1a1a28]`}
              >
                <Plus className="mr-1 h-3 w-3" /> Add rule
              </Button>
            )
          }
        >
          {escalations.length === 0 ? (
            <p className={`text-xs ${DARK.faint}`}>None — sequence simply stops after the last step.</p>
          ) : (
            <div className="space-y-2">
              {escalations.map((r, idx) => (
                <div
                  key={idx}
                  className={`flex flex-wrap items-center gap-2 rounded-lg border ${DARK.panelBorder} ${DARK.panel} px-3 py-2 text-xs ${DARK.body}`}
                >
                  <span>After step</span>
                  <Input
                    type="number" min={1} max={10} value={r.after_step} readOnly={readOnly}
                    onChange={(e) =>
                      setEscalations(escalations.map((x, i) => (i === idx ? { ...x, after_step: Number(e.target.value) || 1 } : x)))
                    }
                    className={`h-7 w-14 ${DARK.input} px-1.5 text-xs ${DARK.inputText}`}
                  />
                  <select
                    disabled={readOnly}
                    value={r.action}
                    onChange={(e) =>
                      setEscalations(escalations.map((x, i) => (i === idx ? { ...x, action: e.target.value as EscalationRule["action"] } : x)))
                    }
                    className={`h-7 rounded ${DARK.input} px-2 text-xs ${DARK.inputText}`}
                  >
                    <option value="pause">pause</option>
                    <option value="notify">notify</option>
                    <option value="handoff">handoff</option>
                  </select>
                  {r.action === "notify" && (
                    <Input
                      type="email"
                      placeholder="email"
                      value={r.notify_email ?? ""}
                      readOnly={readOnly}
                      onChange={(e) =>
                        setEscalations(escalations.map((x, i) => (i === idx ? { ...x, notify_email: e.target.value } : x)))
                      }
                      className={`h-7 w-56 ${DARK.input} px-2 text-xs ${DARK.inputText}`}
                    />
                  )}
                  {!readOnly && (
                    <button type="button" onClick={() => setEscalations(escalations.filter((_, i) => i !== idx))} className={`ml-auto ${DARK.faint} hover:text-red-400`}>
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </SubSection>
      </div>

      <div className="mt-6">
        <SubSection label="Internal Notes">
          <Textarea
            value={notes}
            readOnly={readOnly}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="Anything HOS needs to remember about this playbook…"
            className={`${DARK.input} text-sm ${DARK.body} ${DARK.inputPlaceholder}`}
          />
        </SubSection>
      </div>
    </SectionShell>
  );
}

// ─── Shared shell + helpers ─────────────────────────────────────────────────

function SectionShell({
  label,
  blurb,
  right,
  children,
}: {
  label: string;
  blurb?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3 border-b border-[#1e1e2e] pb-3">
        <div>
          <h2 className="font-['Epilogue',sans-serif] text-xl font-semibold tracking-tight">{label}</h2>
          {blurb && <p className={`mt-1 max-w-2xl text-sm ${DARK.body}`}>{blurb}</p>}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

function SubSection({
  label,
  right,
  children,
}: {
  label: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className={`text-[10px] font-semibold uppercase tracking-[0.15em] ${DARK.faint}`}>{label}</p>
        {right}
      </div>
      {children}
    </div>
  );
}

function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className={`mb-1 text-[10px] uppercase tracking-wider ${DARK.faint}`}>{label}</p>
      {children}
    </div>
  );
}

function ICPField({
  label,
  value,
  onChange,
  readOnly,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  readOnly: boolean;
  placeholder?: string;
}) {
  return (
    <div className={`rounded-xl border ${DARK.panelBorder} ${DARK.panel} p-4`}>
      <p className={`mb-1 text-[10px] uppercase tracking-wider ${DARK.faint}`}>{label}</p>
      <Input
        value={value}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`h-auto border-0 bg-transparent p-0 text-sm font-medium ${DARK.text} placeholder:text-[#3a3a52] focus-visible:ring-0`}
      />
    </div>
  );
}

function ListField({
  label,
  values,
  onChange,
  readOnly,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  readOnly: boolean;
  placeholder: string;
}) {
  return (
    <div>
      <p className={`mb-1 text-[10px] uppercase tracking-wider ${DARK.faint}`}>{label}</p>
      <div className="space-y-1.5">
        {values.map((v, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              value={v}
              readOnly={readOnly}
              onChange={(e) => onChange(values.map((x, j) => (j === i ? e.target.value : x)))}
              placeholder={placeholder}
              className={`${DARK.input} text-sm ${DARK.inputText} ${DARK.inputPlaceholder}`}
            />
            {!readOnly && (
              <button type="button" onClick={() => onChange(values.filter((_, j) => j !== i))} className={`${DARK.faint} hover:text-red-400`}>
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}
        {!readOnly && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onChange([...values, ""])}
            className={`${DARK.input} ${DARK.body} hover:bg-[#1a1a28]`}
          >
            <Plus className="mr-1 h-3 w-3" /> Add
          </Button>
        )}
      </div>
    </div>
  );
}

function ObjectionField({
  responses,
  onChange,
  readOnly,
}: {
  responses: Array<{ objection: string; response: string }>;
  onChange: (v: Array<{ objection: string; response: string }>) => void;
  readOnly: boolean;
}) {
  return (
    <div>
      <p className={`mb-1 text-[10px] uppercase tracking-wider ${DARK.faint}`}>Objection responses</p>
      <div className="space-y-2">
        {responses.map((r, i) => (
          <div key={i} className={`rounded-xl border ${DARK.panelBorder} ${DARK.panel} p-3`}>
            <Input
              value={r.objection}
              readOnly={readOnly}
              onChange={(e) => onChange(responses.map((x, j) => (j === i ? { ...x, objection: e.target.value } : x)))}
              placeholder="Objection — e.g. 'too expensive'"
              className={`mb-2 ${DARK.input} text-sm ${DARK.inputText} ${DARK.inputPlaceholder}`}
            />
            <Textarea
              value={r.response}
              readOnly={readOnly}
              rows={2}
              onChange={(e) => onChange(responses.map((x, j) => (j === i ? { ...x, response: e.target.value } : x)))}
              placeholder="How we respond"
              className={`${DARK.input} text-sm ${DARK.body} ${DARK.inputPlaceholder}`}
            />
            {!readOnly && (
              <button
                type="button"
                onClick={() => onChange(responses.filter((_, j) => j !== i))}
                className={`mt-2 inline-flex items-center gap-1 text-xs ${DARK.faint} hover:text-red-400`}
              >
                <Trash2 className="h-3 w-3" /> Remove
              </button>
            )}
          </div>
        ))}
        {!readOnly && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onChange([...responses, { objection: "", response: "" }])}
            className={`${DARK.input} ${DARK.body} hover:bg-[#1a1a28]`}
          >
            <Plus className="mr-1 h-3 w-3" /> Add objection
          </Button>
        )}
      </div>
    </div>
  );
}

function AgentInput({
  value,
  onChange,
  readOnly,
}: {
  value: string;
  onChange: (v: string) => void;
  readOnly: boolean;
}) {
  return (
    <div>
      <Input
        value={value}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Agent (e.g. outreach-01)"
        list="known-agents"
        className={`${DARK.input} text-sm ${DARK.inputText} ${DARK.inputPlaceholder}`}
      />
      <datalist id="known-agents">
        {KNOWN_AGENTS.map((a) => (
          <option key={a} value={a} />
        ))}
      </datalist>
    </div>
  );
}

function EmptyPanel({ children }: { children: React.ReactNode }) {
  return (
    <p className={`rounded-lg border border-dashed ${DARK.panelBorder} ${DARK.panel} px-4 py-6 text-center text-sm ${DARK.faint}`}>
      {children}
    </p>
  );
}

function StatusPill({ status }: { status: Playbook["status"] }) {
  const map: Record<Playbook["status"], string> = {
    draft: "border-[#262636] bg-[#1a1a28] text-[#b0b0c8]",
    pending_approval: "border-amber-500/30 bg-amber-500/10 text-amber-400",
    approved: "border-[rgba(0,229,160,0.3)] bg-[rgba(0,229,160,0.1)] text-[#00e5a0]",
  };
  return (
    <span className={`rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-wider ${map[status]}`}>
      {status.replace("_", " ")}
    </span>
  );
}

function splitList(v: string): string[] {
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

function reorder<T>(arr: T[], idx: number, delta: number): T[] {
  const target = idx + delta;
  if (target < 0 || target >= arr.length) return arr;
  const next = [...arr];
  [next[idx], next[target]] = [next[target], next[idx]];
  return next;
}

function reorderSteps(steps: PlaybookSequenceStep[], idx: number, delta: number): PlaybookSequenceStep[] {
  return reorder(steps, idx, delta).map((s, i) => ({ ...s, step: i + 1 }));
}

function cryptoId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}
