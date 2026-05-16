"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert } from "@/components/ui/alert";
import { UserPlus, Copy } from "lucide-react";

type InviteResult = {
  ok: true;
  auth_user_id: string;
  invite_link: string | null;
  client_scopes: string[];
  role: string;
};

export function InviteOwnerForm({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InviteResult | null>(null);

  function submit() {
    setError(null);
    const e = email.trim();
    if (!e) {
      setError("Enter an email.");
      return;
    }
    if (!confirm(`Invite ${e} as a portal owner for this client?`)) return;
    start(async () => {
      const res = await fetch(`/api/clients/${clientId}/invite-owner`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: e, full_name: fullName.trim() || undefined }),
      });
      const json = (await res.json().catch(() => null)) as {
        ok: boolean;
        error?: string;
      } | null;
      if (!json?.ok) {
        setError(json?.error ?? `HTTP ${res.status}`);
        return;
      }
      setResult(json as InviteResult);
      setEmail("");
      setFullName("");
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Send a magic-link invite. The recipient gets a portal-only login showing
        their pipeline + activity — they can&apos;t see other clients&apos; data
        (RLS-enforced).
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <Label htmlFor="invite_email">Email</Label>
          <Input
            id="invite_email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="founder@acme.com"
          />
        </div>
        <div>
          <Label htmlFor="invite_name">Full name (optional)</Label>
          <Input
            id="invite_name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Sam Smith"
          />
        </div>
      </div>
      {error && <Alert variant="destructive">{error}</Alert>}
      {result && (
        <Alert variant="success">
          Invite created (auth user <code>{result.auth_user_id.slice(0, 8)}…</code>).
          {result.invite_link && (
            <div className="mt-2 flex items-start gap-2">
              <code className="block flex-1 break-all rounded bg-background/60 px-2 py-1 text-[11px]">
                {result.invite_link}
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => navigator.clipboard.writeText(result.invite_link!)}
              >
                <Copy className="mr-1.5 h-3 w-3" /> Copy
              </Button>
            </div>
          )}
        </Alert>
      )}
      <Button onClick={submit} disabled={pending || !email.trim()} size="sm">
        <UserPlus className="mr-1.5 h-3.5 w-3.5" />
        {pending ? "Sending…" : "Invite owner"}
      </Button>
    </div>
  );
}
