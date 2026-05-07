"use client";

import { useState, useTransition, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert } from "@/components/ui/alert";
import { ArrowDown, ArrowUp, GripVertical, Plus, Save, Send, Trash2 } from "lucide-react";
import { saveDraftPlaybook, submitPlaybookForApproval } from "../actions";
import type {
  ChannelFlags,
  EscalationRule,
  ICP,
  Playbook,
  PlaybookSequenceStep,
  PlaybookVersion,
} from "@/lib/supabase/types";

type EditorPlaybook = Playbook & { clients: { name: string } | null };

type VersionRow = Pick<PlaybookVersion, "id" | "version" | "status" | "created_at" | "change_reason">;

export function PlaybookEditor({
  playbook,
  versions,
}: {
  playbook: EditorPlaybook;
  versions: VersionRow[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
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
  const [notes, setNotes] = useState<string>(playbook.notes ?? "");

  const dirty = useMemo(() => {
    const a = JSON.stringify({
      icp: playbook.icp,
      sequences: playbook.sequences,
      escalation_rules: playbook.escalation_rules,
      channel_flags: playbook.channel_flags,
      notes: playbook.notes,
    });
    const b = JSON.stringify({ icp, sequences: steps, escalation_rules: escalations, channel_flags: channels, notes });
    return a !== b;
  }, [playbook, icp, steps, escalations, channels, notes]);

  function onSave() {
    setError(null);
    setSaved(false);
    start(async () => {
      const r = await saveDraftPlaybook({
        id: playbook.id,
        icp,
        sequences: steps,
        escalation_rules: escalations,
        channel_flags: channels,
        notes,
      });
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
      // Save first to capture latest local changes
      if (dirty) {
        const r1 = await saveDraftPlaybook({
          id: playbook.id,
          icp,
          sequences: steps,
          escalation_rules: escalations,
          channel_flags: channels,
          notes,
        });
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

  return (
    <div className="-m-6 min-h-[calc(100vh-4rem)] bg-[#080810] p-6 text-[#eeeef5]">
      {/* Header */}
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
      {saved && !error && (
        <Alert variant="success" className="mb-4">Saved.</Alert>
      )}

      {/* ICP */}
      <Section label="Ideal Customer Profile">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <ICPField
            label="Industries"
            value={icp.industries?.join(", ") ?? ""}
            onChange={(v) => setIcp({ ...icp, industries: splitList(v) })}
            readOnly={readOnly}
            placeholder="Commercial Property, Facilities Mgmt"
          />
          <ICPField
            label="Company Size"
            value={icp.company_size ?? ""}
            onChange={(v) => setIcp({ ...icp, company_size: v })}
            readOnly={readOnly}
            placeholder="20–500 employees"
          />
          <ICPField
            label="Target Titles"
            value={icp.target_titles?.join(", ") ?? ""}
            onChange={(v) => setIcp({ ...icp, target_titles: splitList(v) })}
            readOnly={readOnly}
            placeholder="Facilities Manager, Office Manager"
          />
          <ICPField
            label="Geography"
            value={icp.geography?.join(", ") ?? ""}
            onChange={(v) => setIcp({ ...icp, geography: splitList(v) })}
            readOnly={readOnly}
            placeholder="Sydney Metro, North Shore"
          />
          <ICPField
            label="Qualification Signal"
            value={icp.qualification_signal ?? ""}
            onChange={(v) => setIcp({ ...icp, qualification_signal: v })}
            readOnly={readOnly}
            placeholder="Multi-site buildings, 1000+ sqm"
          />
          <ICPField
            label="Disqualifiers"
            value={icp.disqualifiers?.join(", ") ?? ""}
            onChange={(v) => setIcp({ ...icp, disqualifiers: splitList(v) })}
            readOnly={readOnly}
            placeholder="Government, Residential"
          />
        </div>
      </Section>

      {/* Sequence */}
      <Section
        label="Email Sequence"
        right={
          !readOnly && (
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
                  },
                ])
              }
              className="border-[#262636] bg-[#14141f] text-[#b0b0c8] hover:bg-[#1a1a28]"
            >
              <Plus className="mr-1 h-3 w-3" /> Add step
            </Button>
          )
        }
      >
        {steps.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[#1e1e2e] bg-[#0e0e18] px-4 py-6 text-center text-sm text-[#52526e]">
            No sequence steps yet.
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
                      <button
                        type="button"
                        onClick={() => moveStep(steps, idx, -1, setSteps)}
                        disabled={idx === 0}
                        className="text-[#52526e] hover:text-[#b0b0c8] disabled:opacity-30"
                      >
                        <ArrowUp className="h-3 w-3" />
                      </button>
                      <GripVertical className="h-3 w-3 text-[#3a3a52]" />
                      <button
                        type="button"
                        onClick={() => moveStep(steps, idx, +1, setSteps)}
                        disabled={idx === steps.length - 1}
                        className="text-[#52526e] hover:text-[#b0b0c8] disabled:opacity-30"
                      >
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
                  <div className="flex items-center gap-3 text-xs text-[#52526e]">
                    <label className="flex items-center gap-1.5">
                      Delay
                      <Input
                        type="number"
                        min={0}
                        max={60}
                        value={s.delay_days}
                        readOnly={readOnly}
                        onChange={(e) =>
                          setSteps(
                            steps.map((x, i) =>
                              i === idx ? { ...x, delay_days: Number(e.target.value) || 0 } : x,
                            ),
                          )
                        }
                        className="h-7 w-16 border-[#262636] bg-[#14141f] px-1.5 text-xs text-[#eeeef5]"
                      />
                      days
                    </label>
                    {!readOnly && (
                      <button
                        type="button"
                        onClick={() => setSteps(steps.filter((_, i) => i !== idx).map((x, i) => ({ ...x, step: i + 1 })))}
                        className="ml-auto inline-flex items-center gap-1 text-[#52526e] hover:text-red-400"
                      >
                        <Trash2 className="h-3 w-3" />
                        Remove
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
            <button
              key={k}
              type="button"
              disabled={readOnly || k !== "email"}
              onClick={() => setChannels({ ...channels, [k]: !channels[k] })}
              className={`rounded-full border px-3 py-1 text-xs capitalize transition-colors ${
                channels[k]
                  ? "border-[rgba(0,229,160,0.3)] bg-[rgba(0,229,160,0.1)] text-[#00e5a0]"
                  : "border-[#262636] bg-[#14141f] text-[#52526e]"
              } ${k !== "email" ? "opacity-50" : ""}`}
              title={k !== "email" ? "Phone + LinkedIn channels coming soon" : ""}
            >
              {k}
              {k !== "email" && " (soon)"}
            </button>
          ))}
        </div>
      </Section>

      {/* Escalation */}
      <Section
        label="Escalation Rules"
        right={
          !readOnly && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setEscalations([
                  ...escalations,
                  { after_step: Math.max(1, steps.length), action: "notify" },
                ])
              }
              className="border-[#262636] bg-[#14141f] text-[#b0b0c8] hover:bg-[#1a1a28]"
            >
              <Plus className="mr-1 h-3 w-3" /> Add rule
            </Button>
          )
        }
      >
        {escalations.length === 0 ? (
          <p className="text-xs text-[#52526e]">
            None — sequence simply stops after the last step.
          </p>
        ) : (
          <div className="space-y-2">
            {escalations.map((r, idx) => (
              <div key={idx} className="flex flex-wrap items-center gap-2 rounded-lg border border-[#1e1e2e] bg-[#0e0e18] px-3 py-2 text-xs text-[#b0b0c8]">
                <span>After step</span>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={r.after_step}
                  readOnly={readOnly}
                  onChange={(e) => updateEscalation(escalations, idx, { after_step: Number(e.target.value) || 1 }, setEscalations)}
                  className="h-7 w-14 border-[#262636] bg-[#14141f] px-1.5 text-xs text-[#eeeef5]"
                />
                <select
                  disabled={readOnly}
                  value={r.action}
                  onChange={(e) => updateEscalation(escalations, idx, { action: e.target.value as EscalationRule["action"] }, setEscalations)}
                  className="h-7 rounded border border-[#262636] bg-[#14141f] px-2 text-xs text-[#eeeef5]"
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
                    onChange={(e) => updateEscalation(escalations, idx, { notify_email: e.target.value }, setEscalations)}
                    className="h-7 w-56 border-[#262636] bg-[#14141f] px-2 text-xs text-[#eeeef5]"
                  />
                )}
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => setEscalations(escalations.filter((_, i) => i !== idx))}
                    className="ml-auto text-[#52526e] hover:text-red-400"
                  >
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
        <Textarea
          value={notes}
          readOnly={readOnly}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="Anything HOS needs to remember about this playbook…"
          className="border-[#262636] bg-[#14141f] text-sm text-[#b0b0c8] placeholder:text-[#52526e]"
        />
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
  label,
  right,
  children,
}: {
  label: string;
  right?: React.ReactNode;
  children: React.ReactNode;
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
    <div className="rounded-xl border border-[#1e1e2e] bg-[#0e0e18] p-4">
      <p className="mb-1 text-[10px] uppercase tracking-wider text-[#52526e]">{label}</p>
      <Input
        value={value}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-auto border-0 bg-transparent p-0 text-sm font-medium text-[#eeeef5] placeholder:text-[#3a3a52] focus-visible:ring-0"
      />
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
  steps: PlaybookSequenceStep[],
  idx: number,
  delta: number,
  set: (next: PlaybookSequenceStep[]) => void,
) {
  const target = idx + delta;
  if (target < 0 || target >= steps.length) return;
  const next = [...steps];
  [next[idx], next[target]] = [next[target], next[idx]];
  set(next.map((s, i) => ({ ...s, step: i + 1 })));
}

function updateEscalation(
  arr: EscalationRule[],
  idx: number,
  patch: Partial<EscalationRule>,
  set: (next: EscalationRule[]) => void,
) {
  set(arr.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
}
