"use client";

import { useTransition, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { ensureDraftPlaybook } from "./actions";

export function EnsureDraftPlaybookButton({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function onClick() {
    setErr(null);
    start(async () => {
      const r = await ensureDraftPlaybook(clientId);
      if (!r.ok) {
        setErr(r.error);
        return;
      }
      router.push(`/playbooks/${r.id}`);
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" onClick={onClick} disabled={pending}>
        <Plus className="mr-1 h-3 w-3" />
        {pending ? "Creating…" : "New draft"}
      </Button>
      {err && <span className="text-xs text-destructive">{err}</span>}
    </div>
  );
}
