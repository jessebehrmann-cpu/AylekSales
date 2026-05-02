"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { LogOut } from "lucide-react";

export function Topbar({ email }: { email: string | null }) {
  const router = useRouter();

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="flex h-16 items-center justify-between border-b bg-background px-6">
      <div className="text-sm text-muted-foreground">
        Signed in as <span className="font-medium text-foreground">{email ?? "—"}</span>
      </div>
      <Button variant="ghost" size="sm" onClick={signOut}>
        <LogOut className="mr-2 h-4 w-4" />
        Sign out
      </Button>
    </header>
  );
}
