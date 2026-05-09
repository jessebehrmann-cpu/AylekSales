"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { GitBranch } from "lucide-react";
import { clonePlaybookFromLive } from "./actions";

export function ProposeChangesButton({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function onClick() {
    start(async () => {
      const r = await clonePlaybookFromLive(clientId);
      if (!r.ok) {
        alert(r.error);
        return;
      }
      router.push(`/playbooks/${r.id}`);
      router.refresh();
    });
  }

  return (
    <Button size="sm" onClick={onClick} disabled={pending}>
      <GitBranch className="mr-1.5 h-3 w-3" />
      {pending ? "Branching…" : "Propose Changes"}
    </Button>
  );
}
