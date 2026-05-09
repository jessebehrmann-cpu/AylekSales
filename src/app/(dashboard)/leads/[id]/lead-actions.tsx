"use client";

import { useTransition, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  addLeadNote,
  deleteLeadAndRedirect,
  markHumanStageComplete,
  unsubscribeLead,
  updateLeadStage,
} from "../actions";
import type { LeadStage } from "@/lib/supabase/types";
import { Trash2, Ban, CheckCircle2 } from "lucide-react";

const STAGES: LeadStage[] = [
  "new",
  "contacted",
  "replied",
  "meeting_booked",
  "quoted",
  "won",
  "lost",
  "unsubscribed",
];

export function StagePicker({ leadId, current }: { leadId: string; current: LeadStage }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onChange(stage: string) {
    setError(null);
    start(async () => {
      const result = await updateLeadStage(leadId, stage as LeadStage);
      if (!result.ok) setError(result.error);
      router.refresh();
    });
  }

  return (
    <div>
      <Select value={current} onValueChange={onChange} disabled={pending}>
        <SelectTrigger className="h-8 w-44 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          {STAGES.map((s) => (
            <SelectItem key={s} value={s}>{s}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}

export function NoteForm({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!note.trim()) return;
    setError(null);
    start(async () => {
      const result = await addLeadNote(leadId, note);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNote("");
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <Textarea
        rows={3}
        placeholder="Internal note — won't be sent to the lead."
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      {error && <Alert variant="destructive">{error}</Alert>}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={pending || !note.trim()}>
          {pending ? "Saving…" : "Add note"}
        </Button>
      </div>
    </form>
  );
}

export function DeleteLeadButton({ leadId }: { leadId: string }) {
  const [pending, start] = useTransition();

  function onClick() {
    if (!confirm("Delete this lead? This cannot be undone.")) return;
    start(async () => {
      await deleteLeadAndRedirect(leadId);
    });
  }

  return (
    <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={onClick} disabled={pending}>
      <Trash2 className="mr-1.5 h-4 w-4" /> Delete
    </Button>
  );
}

export function MarkStageCompleteButton({
  leadId,
  stageId,
  stageName,
  onOpenMeetingModal,
}: {
  leadId: string;
  stageId: string;
  stageName: string;
  /** When set + the stage is have_meeting, the click opens the modal
   *  instead of calling markHumanStageComplete directly. */
  onOpenMeetingModal?: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function onClick() {
    // Have-Meeting stage requires the post-meeting form modal.
    if (stageId === "have_meeting" && onOpenMeetingModal) {
      onOpenMeetingModal();
      return;
    }
    if (
      !confirm(
        `Mark "${stageName}" as complete? The lead will advance to the next stage in the playbook.`,
      )
    )
      return;
    start(async () => {
      const r = await markHumanStageComplete(leadId);
      if (!r.ok) {
        alert(r.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <Button
      size="sm"
      onClick={onClick}
      disabled={pending}
      className="bg-emerald-600 text-white hover:bg-emerald-700"
    >
      <CheckCircle2 className="mr-1.5 h-4 w-4" />
      {pending ? "Advancing…" : `Mark "${stageName}" complete`}
    </Button>
  );
}

export function UnsubscribeLeadButton({
  leadId,
  alreadyUnsubscribed,
}: {
  leadId: string;
  alreadyUnsubscribed: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function onClick() {
    if (!confirm("Unsubscribe this lead? All pending outreach will be cancelled and they'll never be contacted again.")) return;
    start(async () => {
      const r = await unsubscribeLead(leadId);
      if (!r.ok) {
        alert(r.error);
        return;
      }
      router.refresh();
    });
  }

  if (alreadyUnsubscribed) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-xs font-medium text-rose-800">
        <Ban className="h-3 w-3" /> Unsubscribed
      </span>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      className="border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100"
      onClick={onClick}
      disabled={pending}
    >
      <Ban className="mr-1.5 h-3 w-3" />
      {pending ? "Unsubscribing…" : "Unsubscribe"}
    </Button>
  );
}
