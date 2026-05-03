"use client";

import { useTransition, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert } from "@/components/ui/alert";
import { createClient_ } from "../actions";

export function NewClientForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    start(async () => {
      const result = await createClient_(fd);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/clients/${result.id}`);
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {error && <Alert variant="destructive">{error}</Alert>}

      <div className="grid gap-4 md:grid-cols-2">
        <Field id="name" label="Company name" required />
        <Field id="owner_name" label="Owner / contact name" />
        <Field id="email" label="Email" type="email" hint="Required if you want a Stripe subscription auto-created." />
        <Field id="phone" label="Phone" />
        <Field id="suburb" label="Suburb" />
        <Field
          id="retainer_amount"
          label="Retainer (AUD per month)"
          type="number"
          required
          defaultValue="0"
          hint="Stored as whole dollars. Charged monthly via Stripe invoice."
        />
        <Field
          id="revenue_share_pct"
          label="Revenue share %"
          type="number"
          step="0.5"
          defaultValue="8"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" name="notes" rows={4} placeholder="Anything internal — differentiator, vibe, edge cases…" />
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.back()} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create client"}
        </Button>
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  type = "text",
  hint,
  required,
  defaultValue,
  step,
}: {
  id: string;
  label: string;
  type?: string;
  hint?: string;
  required?: boolean;
  defaultValue?: string;
  step?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label} {required && <span className="text-destructive">*</span>}
      </Label>
      <Input id={id} name={id} type={type} required={required} defaultValue={defaultValue} step={step} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
