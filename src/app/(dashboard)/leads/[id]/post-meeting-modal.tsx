"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CheckCircle2, X } from "lucide-react";
import { submitMeetingNotes } from "../actions";
import type { MeetingOutcome } from "@/lib/supabase/types";

const OUTCOMES: Array<{ value: MeetingOutcome; label: string }> = [
  { value: "positive", label: "Positive — strong interest" },
  { value: "neutral", label: "Neutral — needs more info" },
  { value: "negative", label: "Negative — not a fit right now" },
  { value: "no_show", label: "No show" },
];

/**
 * Post-meeting form opened when HOS clicks Mark Complete on the
 * Have-Meeting stage. Captures the outcome + notes + transcript +
 * objections + next steps, then submits to the server action which
 * (a) saves the row to meeting_notes, (b) asks Claude to draft a
 * follow-up proposal, (c) creates a proposal_review approval, and
 * (d) advances the lead to Send Proposal.
 */
export function PostMeetingModal({
  leadId,
  open,
  onOpenChange,
}: {
  leadId: string;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [outcome, setOutcome] = useState<MeetingOutcome>("positive");
  const [notes, setNotes] = useState("");
  const [transcript, setTranscript] = useState("");
  const [objections, setObjections] = useState("");
  const [nextSteps, setNextSteps] = useState("");

  if (!open) return null;

  function reset() {
    setOutcome("positive");
    setNotes("");
    setTranscript("");
    setObjections("");
    setNextSteps("");
    setError(null);
  }

  function close() {
    reset();
    onOpenChange(false);
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const r = await submitMeetingNotes({
        lead_id: leadId,
        outcome,
        notes: notes.trim() || null,
        transcript: transcript.trim() || null,
        objections: objections.trim() || null,
        next_steps: nextSteps.trim() || null,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      reset();
      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <form
        onSubmit={onSubmit}
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-card text-card-foreground shadow-xl"
      >
        <div className="flex items-start justify-between border-b px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold">Capture meeting outcome</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Saved to the lead. The drafted follow-up will land in the approval queue for review before send.
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            disabled={pending}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted"
            title="Cancel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto px-6 py-5">
          <div className="space-y-1.5">
            <Label htmlFor="outcome">Meeting outcome</Label>
            <Select value={outcome} onValueChange={(v) => setOutcome(v as MeetingOutcome)}>
              <SelectTrigger id="outcome">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OUTCOMES.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="notes">Meeting notes</Label>
            <Textarea
              id="notes"
              rows={4}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What happened. Themes, energy, who was on the call, what they liked, what they didn't."
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="transcript">
              Transcript <span className="text-xs text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="transcript"
              rows={4}
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              placeholder="Paste the full or trimmed transcript. Used by Claude to anchor the follow-up — keeps quoting accurate."
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="objections">Key objections raised</Label>
            <Textarea
              id="objections"
              rows={3}
              value={objections}
              onChange={(e) => setObjections(e.target.value)}
              placeholder="Pricing, timing, scope, internal alignment — anything that could kill the deal."
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="next">Agreed next steps</Label>
            <Textarea
              id="next"
              rows={3}
              value={nextSteps}
              onChange={(e) => setNextSteps(e.target.value)}
              placeholder="Send proposal by Friday. Loop in CFO. Demo booked for next Tuesday."
            />
          </div>

          {error && <Alert variant="destructive">{error}</Alert>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t bg-muted/30 px-6 py-3">
          <Button type="button" variant="outline" onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending} className="bg-emerald-600 text-white hover:bg-emerald-700">
            <CheckCircle2 className="mr-1.5 h-4 w-4" />
            {pending ? "Saving + drafting…" : "Submit + draft proposal"}
          </Button>
        </div>
      </form>
    </div>
  );
}
