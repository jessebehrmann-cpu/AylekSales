"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Pause } from "lucide-react";
import { pauseCampaign } from "../actions";

export function PauseButton({ campaignId }: { campaignId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function onClick() {
    if (!confirm("Pause this campaign? Pending sends will be cancelled.")) return;
    start(async () => {
      await pauseCampaign(campaignId);
      router.refresh();
    });
  }

  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={pending}>
      <Pause className="mr-1.5 h-3 w-3" /> {pending ? "Pausing…" : "Pause"}
    </Button>
  );
}
