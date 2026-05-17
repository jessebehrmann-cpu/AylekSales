"use client";

import { useState, useTransition, useMemo, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Check, X } from "lucide-react";
import { bulkApproveLeads, bulkRejectLeads } from "./actions";

/**
 * Bulk approve/reject for pending-approval leads on the leads list.
 *
 * Lifts the per-row checkbox state into context. Components in the table
 * render checkboxes that flip into the shared Set; this component
 * surfaces the sticky action bar + the buttons that hit the bulk server
 * actions.
 *
 * Implementation note: instead of context (overkill for one page) we use
 * a single window-level event bus. The TableRow renders a controlled
 * checkbox bound to `data-pending-lead-id` + dispatches a CustomEvent
 * on change; this bar listens. Tiny + zero re-renders for unrelated
 * rows.
 */

const SELECTION_EVENT = "aylek-lead-selection";
const ALL_TOGGLE_EVENT = "aylek-lead-select-all";

export function dispatchLeadSelection(leadId: string, selected: boolean) {
  window.dispatchEvent(
    new CustomEvent(SELECTION_EVENT, { detail: { leadId, selected } }),
  );
}
export function dispatchSelectAll(selected: boolean) {
  window.dispatchEvent(new CustomEvent(ALL_TOGGLE_EVENT, { detail: { selected } }));
}

export function BulkActionsBar({ allPendingIds }: { allPendingIds: string[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Listen for per-row checkbox events.
  useEffect(() => {
    function onSelect(e: Event) {
      const { leadId, selected: sel } = (e as CustomEvent<{ leadId: string; selected: boolean }>).detail;
      setSelected((prev) => {
        const next = new Set(prev);
        if (sel) next.add(leadId);
        else next.delete(leadId);
        return next;
      });
    }
    function onSelectAll(e: Event) {
      const { selected: sel } = (e as CustomEvent<{ selected: boolean }>).detail;
      setSelected(sel ? new Set(allPendingIds) : new Set());
    }
    window.addEventListener(SELECTION_EVENT, onSelect);
    window.addEventListener(ALL_TOGGLE_EVENT, onSelectAll);
    return () => {
      window.removeEventListener(SELECTION_EVENT, onSelect);
      window.removeEventListener(ALL_TOGGLE_EVENT, onSelectAll);
    };
  }, [allPendingIds]);

  const ids = useMemo(() => Array.from(selected), [selected]);
  if (ids.length === 0) return null;

  function handle(action: "approve" | "reject") {
    setError(null);
    setInfo(null);
    const label = action === "approve" ? "Approve" : "Reject";
    if (!confirm(`${label} ${ids.length} lead${ids.length === 1 ? "" : "s"}?`)) return;
    start(async () => {
      const fn = action === "approve" ? bulkApproveLeads : bulkRejectLeads;
      const r = await fn({ lead_ids: ids });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setInfo(
        `${label}d ${r.updated}.${r.finalised_approval_ids.length > 0 ? ` ${r.finalised_approval_ids.length} parent approval${r.finalised_approval_ids.length === 1 ? "" : "s"} auto-finalised.` : ""}`,
      );
      setSelected(new Set());
      router.refresh();
    });
  }

  return (
    <div className="sticky top-0 z-10 -mx-4 mb-4 flex flex-wrap items-center justify-between gap-2 border-b bg-card/95 px-4 py-2 shadow-sm backdrop-blur sm:mx-0 sm:rounded-md sm:border">
      <div className="flex items-center gap-3 text-sm">
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
          {ids.length} selected
        </span>
        {info && <Alert variant="success" className="inline-flex h-auto px-3 py-1 text-xs">{info}</Alert>}
        {error && <Alert variant="destructive" className="inline-flex h-auto px-3 py-1 text-xs">{error}</Alert>}
      </div>
      <div className="flex items-center gap-2">
        <Button onClick={() => setSelected(new Set())} variant="ghost" size="sm" disabled={pending}>
          Clear
        </Button>
        <Button onClick={() => handle("reject")} variant="outline" size="sm" disabled={pending}>
          <X className="mr-1.5 h-3.5 w-3.5" /> Reject selected
        </Button>
        <Button onClick={() => handle("approve")} size="sm" disabled={pending}>
          <Check className="mr-1.5 h-3.5 w-3.5" /> Approve selected
        </Button>
      </div>
    </div>
  );
}

export function LeadCheckbox({ leadId }: { leadId: string }) {
  const [checked, setChecked] = useState(false);
  // Listen for "select all" so individual row state stays in sync.
  useEffect(() => {
    function onAll(e: Event) {
      const sel = (e as CustomEvent<{ selected: boolean }>).detail.selected;
      setChecked(sel);
    }
    window.addEventListener(ALL_TOGGLE_EVENT, onAll);
    return () => window.removeEventListener(ALL_TOGGLE_EVENT, onAll);
  }, []);
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => {
        setChecked(e.target.checked);
        dispatchLeadSelection(leadId, e.target.checked);
      }}
      className="h-4 w-4 cursor-pointer rounded border-border"
      aria-label={`Select lead ${leadId}`}
    />
  );
}

export function SelectAllPendingCheckbox({ disabled }: { disabled: boolean }) {
  const [checked, setChecked] = useState(false);
  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => {
        setChecked(e.target.checked);
        dispatchSelectAll(e.target.checked);
      }}
      className="h-4 w-4 cursor-pointer rounded border-border"
      aria-label="Select all pending leads"
    />
  );
}
