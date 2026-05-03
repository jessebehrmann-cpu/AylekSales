"use client";

import { useTransition, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createLead } from "../actions";

export function NewLeadForm({
  clients,
  defaultClientId,
}: {
  clients: { id: string; name: string }[];
  defaultClientId?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [clientId, setClientId] = useState(defaultClientId ?? "");

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    fd.set("client_id", clientId);
    start(async () => {
      const result = await createLead(fd);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/leads/${result.id}`);
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {error && <Alert variant="destructive">{error}</Alert>}

      <div className="space-y-1.5">
        <Label htmlFor="client">Client</Label>
        <Select value={clientId} onValueChange={setClientId}>
          <SelectTrigger id="client"><SelectValue placeholder="(none)" /></SelectTrigger>
          <SelectContent>
            {clients.map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Field id="company_name" label="Company" required />
        <Field id="contact_name" label="Contact name" />
        <Field id="title" label="Title" />
        <Field id="email" label="Email" type="email" />
        <Field id="phone" label="Phone" />
        <Field id="suburb" label="Suburb" />
        <Field id="industry" label="Industry" />
        <Field id="employees_estimate" label="Employees (estimate)" type="number" />
        <Field id="website" label="Website" type="url" />
        <Field id="contract_value" label="Estimated contract value (AUD/mo)" type="number" />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" name="notes" rows={3} />
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.back()} disabled={pending}>Cancel</Button>
        <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create lead"}</Button>
      </div>
    </form>
  );
}

function Field({
  id, label, type = "text", required,
}: { id: string; label: string; type?: string; required?: boolean }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label} {required && <span className="text-destructive">*</span>}</Label>
      <Input id={id} name={id} type={type} required={required} />
    </div>
  );
}
