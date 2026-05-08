"use client";

import { useState, useTransition, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert } from "@/components/ui/alert";
import { ArrowDown, ArrowUp, GripVertical, Plus, Save, Send, Sparkles, Trash2 } from "lucide-react";
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
  Strategy,
  TeamMember,
  VoiceTone,
} from "@/lib/supabase/types";

type EditorPlaybook = Playbook & { clients: { name: string } | null };
type VersionRow = Pick<PlaybookVersion, "id" | "version" | "status" | "created_at" | "change_reason">;

const REPLY_KINDS: Array<{ key: ReplyKind; label: string; hint: string }> = [
  { key: "interested", label: "Interested", hint: "They want to learn more or book time." },
  { key: "not_now", label: "Not now", hint: "Wrong timing, try again later." },
  { key: "wrong_person", label: "Wrong person", hint: "Re-routes to a colleague." },
  { key: "unsubscribe", label: "Unsubscribe / opt-out", hint: "Hard stop, no further outreach." },
  { key: "objection", label: "Objection", hint: "Pushback we should address." },
];

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
      notes,
    });
    return a !== b;
  }, [playbook, icp, steps, escalations, channels, strategy, voice, reply, team, notes]);

  /** Strategy or Voice changed since this draft was last saved? Used to show
   *  the Regenerate Sequence button. */
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
      // Save current edits first so the regenerator uses the latest strategy/voice
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
    <div className="-m-6 min-h-[calc(100vh-4rem)] bg-[#080810] p-6 text-[#eeeef5]">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3 border-b border-[#1e1e2e] pb-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-[#52526e]">
            {playbook.clients?.name ?? "Client"} · Playbook
          </p>
          <h1 className="mt-1 font-['Epilogue',sans-serif] text-2xl font-bold tracking-tight">
            v{playbook.version}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill status={playbook.status} />
          {!readOnly && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={onSave}
                disabled={pending || !dirty}
                className="border-[#262636] bg-[#14141f] text-[#b0b0c8] hover:bg-[#1a1a28]"
              >
                <Save className="mr-1 h-3 w-3" />
                {pending ? "Saving…" : "Save draft"}
              </Button>
              <Button
                size="sm"
                onClick={onSubmit}
                disabled={pending}
                className="bg-[#00e5a0] text-black hover:bg-[#00e5a0]/90"
              >
                <Send className="mr-1 h-3 w-3" />
                Submit for approval
              </Button>
            </>
          )}
        </div>
      </div>

      {readOnly && (
        <Alert className="mb-4 border-amber-500/30 bg-amber-500/5 text-amber-300">
          {playbook.status === "approved"
            ? "This playbook is approved and locked. To make changes, create a new draft and submit it for approval."
            : "This playbook is awaiting HOS approval. Reject it to return to draft."}
        </Alert>
      )}

      {error && <Alert variant="destructive" className="mb-4">{error}</Alert>}
      {saved && !error && <Alert variant="success" className="mb-4">Saved.</Alert>}
      {aiWarning && (
        <Alert className="mb-4 border-amber-500/30 bg-amber-500/5 text-amber-300">
          <strong>{aiWarning}</strong> A placeholder sequence was used — edit the steps and try again once the API key is set.
        </Alert>
      )}

      {/* ICP */}
      <Section label="Ideal Customer Profile">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <ICPField label="Industries" value={icp.industries?.join(", ") ?? ""}
            onChange={(v) => setIcp({ ...icp, industries: splitList(v) })} readOnly={readOnly}
            placeholder="e.g. SaaS, Logistics, Construction" />
          <ICPField label="Company Size" value={icp.company_size ?? ""}
            onChange={(v) => setIcp({ ...icp, company_size: v })} readOnly={readOnly}
            placeholder="20–500 employees" />
          <ICPField label="Target Titles" value={icp.target_titles?.join(", ") ?? ""}
            onChange={(v) => setIcp({ ...icp, target_titles: splitList(v) })} readOnly={readOnly}
            placeholder="Head of Ops, VP Sales" />
          <ICPField label="Geography" value={icp.geography?.join(", ") ?? ""}
            onChange={(v) => setIcp({ ...icp, geography: splitList(v) })} readOnly={readOnly}
            placeholder="ANZ, North America" />
          <ICPField label="Qualification Signal" value={icp.qualification_signal ?? ""}
            onChange={(v) => setIcp({ ...icp, qualification_signal: v })} readOnly={readOnly}
            placeholder="e.g. Series B+, multi-region team" />
          <ICPField label="Disqualifiers" value={icp.disqualifiers?.join(", ") ?? ""}
            onChange={(v) => setIcp({ ...icp, disqualifiers: splitList(v) })} readOnly={readOnly}
            placeholder="Government, under 10 staff" />
        </div>
      </Section>

      {/* Strategy */}
      <Section label="Company Strategy & Key Messaging">
        <div className="space-y-3">
          <Field label="Value proposition">
            <Textarea
              value={strategy.value_proposition ?? ""}
              readOnly={readOnly}
              rows={2}
              onChange={(e) => setStrategy({ ...strategy, value_proposition: e.target.value })}
              placeholder="One sentence — the buyer-facing version of why we exist."
              className="border-[#262636] bg-[#14141f] text-sm text-[#eeeef5] placeholder:text-[#52526e]"
            />
          </Field>
          <ListField label="Key messages" values={strategy.key_messages ?? []}
            onChange={(arr) => setStrategy({ ...strategy, key_messages: arr })}
            readOnly={readOnly} placeholder="Add a key message" />
          <ListField label="Proof points" values={strategy.proof_points ?? []}
            onChange={(arr) => setStrategy({ ...strategy, proof_points: arr })}
            readOnly={readOnly} placeholder="Add a metric, case study, or quote" />
          <ObjectionField responses={strategy.objection_responses ?? []}
            onChange={(arr) => setStrategy({ ...strategy, objection_responses: arr })}
            readOnly={readOnly} />
        </div>
      </Section>

      {/* Voice & Tone */}
      <Section label="Company Voice & Tone">
        <div className="space-y-3">
          <ListField label="Tone descriptors" values={voice.tone_descriptors ?? []}
            onChange={(arr) => setVoice({ ...voice, tone_descriptors: arr })}
            readOnly={readOnly} placeholder="e.g. direct, warm, dry-witted" />
          <Field label="Writing style">
            <Textarea
              value={voice.writing_style ?? ""}
              readOnly={readOnly}
              rows={3}
              onChange={(e) => setVoice({ ...voice, writing_style: e.target.value })}
              placeholder="Sentence length, contractions, lowercase opening lines, etc."
              className="border-[#262636] bg-[#14141f] text-sm text-[#eeeef5] placeholder:text-[#52526e]"
            />
          </Field>
          <ListField label="What to avoid" values={voice.avoid ?? []}
            onChange={(arr) => setVoice({ ...voice, avoid: arr })}
            readOnly={readOnly} placeholder="e.g. corporate speak, exclamation marks" />
          <ListField label="Example phrases" values={voice.example_phrases ?? []}
            onChange={(arr) => setVoice({ ...voice, example_phrases: arr })}
            readOnly={readOnly} placeholder="A line that sounds like us" />
        </div>
      </Section>

      {/* Reply Strategy */}
      <Section label="Reply Strategy">
        <div className="space-y-2">
          {REPLY_KINDS.map(({ key, label, hint }) => {
            const r = reply[key] ?? {};
            return (
              <div key={key} className="rounded-xl border border-[#1e1e2e] bg-[#0e0e18] p-3">
                <div className="mb-2 flex items-baseline justify-between">
                  <p className="text-sm font-semibold text-[#eeeef5]">{label}</p>
                  <p className="text-[10px] uppercase tracking-wider text-[#52526e]">{hint}</p>
                </div>
                <Input
                  value={r.action ?? ""}
                  readOnly={readOnly}
                  onChange={(e) => setReply({ ...reply, [key]: { ...r, action: e.target.value } })}
                  placeholder="Action — e.g. book meeting, mark unsubscribed, snooze 90 days"
                  className="mb-2 border-[#262636] bg-[#14141f] text-sm text-[#eeeef5] placeholder:text-[#52526e]"
                />
                <Textarea
                  value={r.template ?? ""}
                  readOnly={readOnly}
                  rows={2}
                  onChange={(e) => setReply({ ...reply, [key]: { ...r, template: e.target.value } })}
                  placeholder="Reply template — leave blank if no auto-reply for this kind."
                  className="border-[#262636] bg-[#14141f] text-sm text-[#b0b0c8] placeholder:text-[#52526e]"
                />
              </div>
            );
          })}
        </div>
      </Section>

      {/* Team Members */}
      <Section
        label="Team Members"
        right={
          !readOnly && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setTeam([
                  ...team,
                  { id: cryptoId(), name: "", title: "", email: "" },
                ])
              }
              className="border-[#262636] bg-[#14141f] text-[#b0b0c8] hover:bg-[#1a1a28]"
            >
              <Plus className="mr-1 h-3 w-3" /> Add member
            </Button>
          )
        }
      >
        {team.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[#1e1e2e] bg-[#0e0e18] px-4 py-6 text-center text-sm text-[#52526e]">
            No team members yet. Add at least one — the first member is the default sender on every step.
          </p>
        ) : (
          <div className="space-y-2">
            {team.map((m, idx) => (
              <div key={m.id} className="grid grid-cols-1 gap-2 rounded-xl border border-[#1e1e2e] bg-[#0e0e18] p-3 md:grid-cols-[1fr,1fr,1.5fr,auto]">
                <Input value={m.name} readOnly={readOnly}
                  onChange={(e) => setTeam(team.map((x, i) => i === idx ? { ...x, name: e.target.value } : x))}
                  placeholder="Name (e.g. Jesse Behrmann)"
                  className="border-[#262636] bg-[#14141f] text-sm text-[#eeeef5] placeholder:text-[#52526e]" />
                <Input value={m.title} readOnly={readOnly}
                  onChange={(e) => setTeam(team.map((x, i) => i === idx ? { ...x, title: e.target.value } : x))}
                  placeholder="Title (e.g. CEO)"
                  className="border-[#262636] bg-[#14141f] text-sm text-[#eeeef5] placeholder:text-[#52526e]" />
                <Input type="email" value={m.email} readOnly={readOnly}
                  onChange={(e) => setTeam(team.map((x, i) => i === idx ? { ...x, email: e.target.value } : x))}
                  placeholder="email@company.com"
                  className="border-[#262636] bg-[#14141f] text-sm text-[#eeeef5] placeholder:text-[#52526e]" />
                {!readOnly && (
                  <button type="button"
                    onClick={() => {
                      setTeam(team.filter((_, i) => i !== idx));
                      // any step pointing at this index needs reset
                      setSteps(steps.map((s) => ({ ...s, sender_index: s.sender_index === idx ? null : s.sender_index })));
                    }}
                    className="text-[#52526e] hover:text-red-400">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Sequence */}
      <Section
        label="Email Sequence"
        right={
          <div className="flex items-center gap-2">
            {!readOnly && hasStrategyOrVoiceContent && (
              <Button
                size="sm"
                onClick={onRegenerate}
                disabled={aiPending || pending}
                className="bg-[rgba(0,229,160,0.15)] text-[#00e5a0] hover:bg-[rgba(0,229,160,0.25)]"
                title={
                  strategyOrVoiceDirty
                    ? "Regenerate using the latest Strategy + Voice"
                    : "Regenerate using current Strategy + Voice"
                }
              >
                <Sparkles className="mr-1 h-3 w-3" />
                {aiPending ? "Regenerating…" : "Regenerate sequence"}
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
                className="border-[#262636] bg-[#14141f] text-[#b0b0c8] hover:bg-[#1a1a28]"
              >
                <Plus className="mr-1 h-3 w-3" /> Add step
              </Button>
            )}
          </div>
        }
      >
        {steps.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[#1e1e2e] bg-[#0e0e18] px-4 py-6 text-center text-sm text-[#52526e]">
            No sequence steps yet. {hasStrategyOrVoiceContent && "Click Regenerate sequence to draft one from your strategy + voice."}
          </p>
        ) : (
          <div className="space-y-2">
            {steps.map((s, idx) => (
              <div key={idx} className="flex items-start gap-3 rounded-xl border border-[#1e1e2e] bg-[#0e0e18] p-4">
                <div className="flex flex-col items-center gap-1 pt-1">
                  <div className="flex h-7 w-7 items-center justify-center rounded-full border border-[rgba(0,229,160,0.2)] bg-[rgba(0,229,160,0.08)] text-xs font-bold text-[#00e5a0]">
                    {idx + 1}
                  </div>
                  {!readOnly && (
                    <>
                      <button type="button" onClick={() => moveStep(steps, idx, -1, setSteps)}
                        disabled={idx === 0}
                        className="text-[#52526e] hover:text-[#b0b0c8] disabled:opacity-30">
                        <ArrowUp className="h-3 w-3" />
                      </button>
                      <GripVertical className="h-3 w-3 text-[#3a3a52]" />
                      <button type="button" onClick={() => moveStep(steps, idx, +1, setSteps)}
                        disabled={idx === steps.length - 1}
                        className="text-[#52526e] hover:text-[#b0b0c8] disabled:opacity-30">
                        <ArrowDown className="h-3 w-3" />
                      </button>
                    </>
                  )}
                </div>
                <div className="flex-1 space-y-2">
                  <Input
                    value={s.subject}
                    readOnly={readOnly}
                    onChange={(e) =>
                      setSteps(steps.map((x, i) => (i === idx ? { ...x, subject: e.target.value } : x)))
                    }
                    placeholder="Subject line"
                    className="border-[#262636] bg-[#14141f] text-sm text-[#eeeef5] placeholder:text-[#52526e]"
                  />
                  <Textarea
                    value={s.body}
                    readOnly={readOnly}
                    rows={4}
                    onChange={(e) =>
                      setSteps(steps.map((x, i) => (i === idx ? { ...x, body: e.target.value } : x)))
                    }
                    placeholder="Body (use {{contact_name}} and {{company_name}})"
                    className="border-[#262636] bg-[#14141f] text-sm text-[#b0b0c8] placeholder:text-[#52526e]"
                  />
                  <div className="flex flex-wrap items-center gap-3 text-xs text-[#52526e]">
                    <label className="flex items-center gap-1.5">
                      Delay
                      <Input
                        type="number" min={0} max={60} value={s.delay_days} readOnly={readOnly}
                        onChange={(e) =>
                          setSteps(steps.map((x, i) =>
                            i === idx ? { ...x, delay_days: Number(e.target.value) || 0 } : x))
                        }
                        className="h-7 w-16 border-[#262636] bg-[#14141f] px-1.5 text-xs text-[#eeeef5]"
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
                        className="h-7 rounded border border-[#262636] bg-[#14141f] px-2 text-xs text-[#eeeef5] disabled:opacity-50"
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
                      <button type="button"
                        onClick={() => setSteps(steps.filter((_, i) => i !== idx).map((x, i) => ({ ...x, step: i + 1 })))}
                        className="ml-auto inline-flex items-center gap-1 text-[#52526e] hover:text-red-400">
                        <Trash2 className="h-3 w-3" /> Remove
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Channels */}
      <Section label="Channels">
        <div className="flex gap-2">
          {(Object.keys(channels) as Array<keyof ChannelFlags>).map((k) => (
            <button key={k} type="button" disabled={readOnly || k !== "email"}
              onClick={() => setChannels({ ...channels, [k]: !channels[k] })}
              className={`rounded-full border px-3 py-1 text-xs capitalize transition-colors ${
                channels[k]
                  ? "border-[rgba(0,229,160,0.3)] bg-[rgba(0,229,160,0.1)] text-[#00e5a0]"
                  : "border-[#262636] bg-[#14141f] text-[#52526e]"
              } ${k !== "email" ? "opacity-50" : ""}`}
              title={k !== "email" ? "Phone + LinkedIn channels coming soon" : ""}>
              {k}{k !== "email" && " (soon)"}
            </button>
          ))}
        </div>
      </Section>

      {/* Escalation */}
      <Section label="Escalation Rules" right={
        !readOnly && (
          <Button variant="outline" size="sm"
            onClick={() => setEscalations([...escalations, { after_step: Math.max(1, steps.length), action: "notify" }])}
            className="border-[#262636] bg-[#14141f] text-[#b0b0c8] hover:bg-[#1a1a28]">
            <Plus className="mr-1 h-3 w-3" /> Add rule
          </Button>
        )
      }>
        {escalations.length === 0 ? (
          <p className="text-xs text-[#52526e]">None — sequence simply stops after the last step.</p>
        ) : (
          <div className="space-y-2">
            {escalations.map((r, idx) => (
              <div key={idx} className="flex flex-wrap items-center gap-2 rounded-lg border border-[#1e1e2e] bg-[#0e0e18] px-3 py-2 text-xs text-[#b0b0c8]">
                <span>After step</span>
                <Input type="number" min={1} max={10} value={r.after_step} readOnly={readOnly}
                  onChange={(e) => updateEscalation(escalations, idx, { after_step: Number(e.target.value) || 1 }, setEscalations)}
                  className="h-7 w-14 border-[#262636] bg-[#14141f] px-1.5 text-xs text-[#eeeef5]" />
                <select disabled={readOnly} value={r.action}
                  onChange={(e) => updateEscalation(escalations, idx, { action: e.target.value as EscalationRule["action"] }, setEscalations)}
                  className="h-7 rounded border border-[#262636] bg-[#14141f] px-2 text-xs text-[#eeeef5]">
                  <option value="pause">pause</option>
                  <option value="notify">notify</option>
                  <option value="handoff">handoff</option>
                </select>
                {r.action === "notify" && (
                  <Input type="email" placeholder="email" value={r.notify_email ?? ""} readOnly={readOnly}
                    onChange={(e) => updateEscalation(escalations, idx, { notify_email: e.target.value }, setEscalations)}
                    className="h-7 w-56 border-[#262636] bg-[#14141f] px-2 text-xs text-[#eeeef5]" />
                )}
                {!readOnly && (
                  <button type="button" onClick={() => setEscalations(escalations.filter((_, i) => i !== idx))}
                    className="ml-auto text-[#52526e] hover:text-red-400">
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Notes */}
      <Section label="Internal Notes">
        <Textarea value={notes} readOnly={readOnly} onChange={(e) => setNotes(e.target.value)} rows={3}
          placeholder="Anything HOS needs to remember about this playbook…"
          className="border-[#262636] bg-[#14141f] text-sm text-[#b0b0c8] placeholder:text-[#52526e]" />
      </Section>

      {/* Version history */}
      {versions.length > 0 && (
        <Section label={`Version History (${versions.length})`}>
          <ul className="divide-y divide-[#1e1e2e] text-xs text-[#b0b0c8]">
            {versions.map((v) => (
              <li key={v.id} className="flex items-center justify-between py-2">
                <span>v{v.version} — {v.status}</span>
                <span className="text-[#52526e]">{new Date(v.created_at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function Section({
  label, right, children,
}: {
  label: string; right?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="mb-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#52526e]">{label}</h2>
        {right}
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-[10px] uppercase tracking-wider text-[#52526e]">{label}</p>
      {children}
    </div>
  );
}

function ICPField({
  label, value, onChange, readOnly, placeholder,
}: { label: string; value: string; onChange: (v: string) => void; readOnly: boolean; placeholder?: string }) {
  return (
    <div className="rounded-xl border border-[#1e1e2e] bg-[#0e0e18] p-4">
      <p className="mb-1 text-[10px] uppercase tracking-wider text-[#52526e]">{label}</p>
      <Input value={value} readOnly={readOnly} onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-auto border-0 bg-transparent p-0 text-sm font-medium text-[#eeeef5] placeholder:text-[#3a3a52] focus-visible:ring-0" />
    </div>
  );
}

/** Editable list of strings with add/remove inline. */
function ListField({
  label, values, onChange, readOnly, placeholder,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  readOnly: boolean;
  placeholder: string;
}) {
  return (
    <div>
      <p className="mb-1 text-[10px] uppercase tracking-wider text-[#52526e]">{label}</p>
      <div className="space-y-1.5">
        {values.map((v, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input value={v} readOnly={readOnly}
              onChange={(e) => onChange(values.map((x, j) => (j === i ? e.target.value : x)))}
              placeholder={placeholder}
              className="border-[#262636] bg-[#14141f] text-sm text-[#eeeef5] placeholder:text-[#52526e]" />
            {!readOnly && (
              <button type="button" onClick={() => onChange(values.filter((_, j) => j !== i))}
                className="text-[#52526e] hover:text-red-400">
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}
        {!readOnly && (
          <Button variant="outline" size="sm" onClick={() => onChange([...values, ""])}
            className="border-[#262636] bg-[#14141f] text-[#b0b0c8] hover:bg-[#1a1a28]">
            <Plus className="mr-1 h-3 w-3" /> Add
          </Button>
        )}
      </div>
    </div>
  );
}

function ObjectionField({
  responses, onChange, readOnly,
}: {
  responses: Array<{ objection: string; response: string }>;
  onChange: (v: Array<{ objection: string; response: string }>) => void;
  readOnly: boolean;
}) {
  return (
    <div>
      <p className="mb-1 text-[10px] uppercase tracking-wider text-[#52526e]">Objection responses</p>
      <div className="space-y-2">
        {responses.map((r, i) => (
          <div key={i} className="rounded-xl border border-[#1e1e2e] bg-[#0e0e18] p-3">
            <Input value={r.objection} readOnly={readOnly}
              onChange={(e) => onChange(responses.map((x, j) => (j === i ? { ...x, objection: e.target.value } : x)))}
              placeholder="Objection — e.g. 'too expensive'"
              className="mb-2 border-[#262636] bg-[#14141f] text-sm text-[#eeeef5] placeholder:text-[#52526e]" />
            <Textarea value={r.response} readOnly={readOnly} rows={2}
              onChange={(e) => onChange(responses.map((x, j) => (j === i ? { ...x, response: e.target.value } : x)))}
              placeholder="How we respond"
              className="border-[#262636] bg-[#14141f] text-sm text-[#b0b0c8] placeholder:text-[#52526e]" />
            {!readOnly && (
              <button type="button" onClick={() => onChange(responses.filter((_, j) => j !== i))}
                className="mt-2 inline-flex items-center gap-1 text-xs text-[#52526e] hover:text-red-400">
                <Trash2 className="h-3 w-3" /> Remove
              </button>
            )}
          </div>
        ))}
        {!readOnly && (
          <Button variant="outline" size="sm"
            onClick={() => onChange([...responses, { objection: "", response: "" }])}
            className="border-[#262636] bg-[#14141f] text-[#b0b0c8] hover:bg-[#1a1a28]">
            <Plus className="mr-1 h-3 w-3" /> Add objection
          </Button>
        )}
      </div>
    </div>
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

function moveStep(
  steps: PlaybookSequenceStep[], idx: number, delta: number,
  set: (next: PlaybookSequenceStep[]) => void,
) {
  const target = idx + delta;
  if (target < 0 || target >= steps.length) return;
  const next = [...steps];
  [next[idx], next[target]] = [next[target], next[idx]];
  set(next.map((s, i) => ({ ...s, step: i + 1 })));
}

function updateEscalation(
  arr: EscalationRule[], idx: number, patch: Partial<EscalationRule>,
  set: (next: EscalationRule[]) => void,
) {
  set(arr.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
}

function cryptoId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}
