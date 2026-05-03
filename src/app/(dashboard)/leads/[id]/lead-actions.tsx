"use client";

import { useTransition, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { addLeadNote, deleteLeadAndRedirect, updateLeadStage } from "../actions";
import type { LeadStage } from "@/lib/supabase/types";
import { Trash2 } from "lucide-react";

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
