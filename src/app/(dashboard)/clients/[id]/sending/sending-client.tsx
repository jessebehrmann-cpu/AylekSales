"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, RefreshCw, Pause, Play, ExternalLink } from "lucide-react";
import type { ClientEmailConfig } from "@/lib/supabase/types";

export function SendingClient({
  clientId,
  initialConfig,
}: {
  clientId: string;
  initialConfig: ClientEmailConfig | null;
}) {
  const router = useRouter();
  const [config, setConfig] = useState<ClientEmailConfig | null>(initialConfig);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [domain, setDomain] = useState("");
  const [fromLocal, setFromLocal] = useState("hello");
  const [replyLocal, setReplyLocal] = useState("replies");

  function createDomainAction() {
    setError(null);
    setInfo(null);
    const d = domain.trim();
    if (!d) {
      setError("Enter a domain.");
      return;
    }
    if (
      !confirm(
        `Create a Resend sending domain for ${d}? You'll need to paste DKIM + SPF records into the domain's DNS afterward.`,
      )
    )
      return;
    start(async () => {
      const res = await fetch(`/api/clients/${clientId}/sending/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: d, from_local: fromLocal, reply_to_local: replyLocal }),
      });
      const json = (await res.json().catch(() => null)) as {
        ok: boolean;
        error?: string;
        config?: ClientEmailConfig;
      } | null;
      if (!json?.ok || !json.config) {
        setError(json?.error ?? "Failed to create domain.");
        return;
      }
      setConfig(json.config);
      setInfo("Domain created. Paste the DNS records below into your domain registrar, then click Recheck.");
      router.refresh();
    });
  }

  function recheckAction() {
    setError(null);
    setInfo(null);
    start(async () => {
      const res = await fetch(`/api/clients/${clientId}/sending/recheck`, {
        method: "POST",
      });
      const json = (await res.json().catch(() => null)) as {
        ok: boolean;
        error?: string;
        config?: ClientEmailConfig;
        resend_status?: string;
      } | null;
      if (!json?.ok || !json.config) {
        setError(json?.error ?? "Recheck failed.");
        return;
      }
      setConfig(json.config);
      setInfo(
        json.config.status === "verified"
          ? "Domain verified — outbound from this client will now use the per-client address."
          : `Resend says: ${json.resend_status ?? "still pending"}. Re-check in a few minutes.`,
      );
      router.refresh();
    });
  }

  function toggleAction(action: "pause" | "resume") {
    setError(null);
    setInfo(null);
    if (!confirm(action === "pause" ? "Pause outbound for this client?" : "Resume outbound?")) return;
    start(async () => {
      const res = await fetch(`/api/clients/${clientId}/sending/pause`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const json = (await res.json().catch(() => null)) as {
        ok: boolean;
        error?: string;
        config?: ClientEmailConfig;
      } | null;
      if (!json?.ok || !json.config) {
        setError(json?.error ?? "Failed to change status.");
        return;
      }
      setConfig(json.config);
      router.refresh();
    });
  }

  if (!config) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          This client has no dedicated sending domain yet — outbound currently goes from the
          global Aylek address. Create one to isolate this client&apos;s deliverability and route
          replies correctly.
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="md:col-span-3">
            <Label htmlFor="domain">Sending domain</Label>
            <Input
              id="domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="acme-sales.io"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Pick a domain or subdomain the client controls. We&apos;ll send AS{" "}
              <code>{fromLocal || "hello"}@&lt;domain&gt;</code> and route replies to{" "}
              <code>{replyLocal || "replies"}@&lt;domain&gt;</code>.
            </p>
          </div>
          <div>
            <Label htmlFor="from_local">From local-part</Label>
            <Input id="from_local" value={fromLocal} onChange={(e) => setFromLocal(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="reply_to_local">Reply-to local-part</Label>
            <Input id="reply_to_local" value={replyLocal} onChange={(e) => setReplyLocal(e.target.value)} />
          </div>
        </div>
        {error && <Alert variant="destructive">{error}</Alert>}
        {info && <Alert variant="success">{info}</Alert>}
        <Button onClick={createDomainAction} disabled={pending || !domain.trim()}>
          {pending ? "Creating…" : "Create domain"}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={config.status} />
        <span className="text-sm text-muted-foreground">
          Sends as <strong className="text-foreground">{config.from_email}</strong>, replies to{" "}
          <strong className="text-foreground">{config.reply_to}</strong>
        </span>
      </div>
      {error && <Alert variant="destructive">{error}</Alert>}
      {info && <Alert variant="success">{info}</Alert>}
      {config.last_error && (
        <Alert variant="destructive">Resend said: {config.last_error}</Alert>
      )}

      <div className="flex flex-wrap gap-2">
        <Button onClick={recheckAction} disabled={pending} variant="outline">
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          {pending ? "Checking…" : "Recheck DNS"}
        </Button>
        {config.status !== "paused" ? (
          <Button onClick={() => toggleAction("pause")} disabled={pending} variant="outline">
            <Pause className="mr-1.5 h-3.5 w-3.5" /> Pause outbound
          </Button>
        ) : (
          <Button onClick={() => toggleAction("resume")} disabled={pending}>
            <Play className="mr-1.5 h-3.5 w-3.5" /> Resume
          </Button>
        )}
        {config.resend_domain_id && (
          <Button asChild variant="outline">
            <a
              href={`https://resend.com/domains/${config.resend_domain_id}`}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" /> Open in Resend
            </a>
          </Button>
        )}
      </div>

      <div>
        <h3 className="text-sm font-medium">DNS records to add</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Paste each row into the DNS of the domain&apos;s registrar (Cloudflare,
          Squarespace, etc.). Then click <strong>Recheck DNS</strong> above.
        </p>
        <div className="mt-3 overflow-x-auto rounded-lg border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Type</th>
                <th className="px-3 py-2 text-left font-medium">Name</th>
                <th className="px-3 py-2 text-left font-medium">Value</th>
                <th className="px-3 py-2 text-left font-medium">TTL</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {(config.dns_records ?? []).map((r, i) => (
                <tr key={i}>
                  <td className="px-3 py-2 font-mono">{r.type}</td>
                  <td className="px-3 py-2 font-mono">{r.name}</td>
                  <td className="px-3 py-2 font-mono break-all">{r.value}</td>
                  <td className="px-3 py-2 font-mono">{r.ttl ?? "Auto"}</td>
                  <td className="px-3 py-2">
                    <Badge variant={r.status === "verified" ? "success" : "muted"}>
                      {r.status ?? "pending"}
                    </Badge>
                  </td>
                </tr>
              ))}
              {(config.dns_records ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-4 text-center text-muted-foreground">
                    No DNS records returned by Resend yet — click Recheck.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: ClientEmailConfig["status"] }) {
  if (status === "verified") {
    return (
      <Badge variant="success" className="gap-1">
        <CheckCircle2 className="h-3 w-3" /> Verified
      </Badge>
    );
  }
  if (status === "paused") return <Badge variant="muted">Paused</Badge>;
  return <Badge variant="warning">Unverified</Badge>;
}
