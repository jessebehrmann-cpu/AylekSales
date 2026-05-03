"use client";

import { useTransition, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { updateClient } from "../actions";
import type { Client } from "@/lib/supabase/types";

export function EditClientForm({ client }: { client: Client }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [status, setStatus] = useState<Client["status"]>(client.status);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    const fd = new FormData(e.currentTarget);
    fd.set("status", status);
    fd.set("id", client.id);
    start(async () => {
      const result = await updateClient(fd);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {error && <Alert variant="destructive">{error}</Alert>}
      {saved && !error && <Alert variant="success">Saved.</Alert>}

      <div className="grid gap-4 md:grid-cols-2">
        <Field id="name" label="Company name" defaultValue={client.name} required />
        <Field id="owner_name" label="Owner / contact" defaultValue={client.owner_name ?? ""} />
        <Field id="email" label="Email" type="email" defaultValue={client.email ?? ""} />
        <Field id="phone" label="Phone" defaultValue={client.phone ?? ""} />
        <Field id="suburb" label="Suburb" defaultValue={client.suburb ?? ""} />
        <Field
          id="retainer_amount"
          label="Retainer (AUD/mo)"
          type="number"
          defaultValue={(client.retainer_amount ?? 0).toString()}
        />
        <Field
          id="revenue_share_pct"
          label="Revenue share %"
          type="number"
          step="0.5"
          defaultValue={client.revenue_share_pct.toString()}
        />
        <div className="space-y-1.5">
          <Label htmlFor="status">Status</Label>
          <Select value={status} onValueChange={(v) => setStatus(v as Client["status"])}>
            <SelectTrigger id="status"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="paused">Paused</SelectItem>
              <SelectItem value="churned">Churned</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" name="notes" rows={4} defaultValue={client.notes ?? ""} />
      </div>

      <div className="flex items-center justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  type = "text",
  defaultValue,
  required,
  step,
}: {
  id: string;
  label: string;
  type?: string;
  defaultValue?: string;
  required?: boolean;
  step?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={id} type={type} defaultValue={defaultValue} required={required} step={step} />
    </div>
  );
}
