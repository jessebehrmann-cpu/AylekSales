"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Papa from "papaparse";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Upload, Sparkles, Check } from "lucide-react";
import { commitLeadImport } from "./actions";

type Target = { key: string; label: string; required?: boolean };
const TARGETS: Target[] = [
  { key: "company_name", required: true, label: "Company name" },
  { key: "contact_name", label: "Contact name" },
  { key: "title", label: "Title" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "suburb", label: "Suburb" },
  { key: "industry", label: "Industry" },
  { key: "employees_estimate", label: "Employees (est.)" },
  { key: "website", label: "Website" },
];

type Mapping = Record<string, string | null>;

export function ImportWizard({ clients }: { clients: { id: string; name: string }[] }) {
  const router = useRouter();
  const [phase, setPhase] = useState<"upload" | "mapping" | "done">("upload");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Mapping>({});
  const [clientId, setClientId] = useState<string>("");
  const [aiPending, setAiPending] = useState(false);
  const [aiWarning, setAiWarning] = useState<string | null>(null);
  const [commitPending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ inserted: number; skipped: number } | null>(null);

  async function onFile(file: File) {
    setError(null);
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (result) => {
        if (result.errors.length > 0) {
          setError(`Parse error: ${result.errors[0].message}`);
          return;
        }
        const fileHeaders = result.meta.fields ?? Object.keys(result.data[0] ?? {});
        if (fileHeaders.length === 0) {
          setError("No columns detected.");
          return;
        }
        setHeaders(fileHeaders);
        setRows(result.data);
        setPhase("mapping");

        // Kick off AI mapping
        setAiPending(true);
        setAiWarning(null);
        try {
          const res = await fetch("/api/leads/map", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ headers: fileHeaders, rows: result.data.slice(0, 3) }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = (await res.json()) as { mapping: Mapping; warning?: string };
          setMapping(json.mapping);
          if (json.warning) setAiWarning(json.warning);
        } catch (e) {
          // Fallback: empty mapping; user maps manually
          console.error(e);
          setMapping({});
          setAiWarning("AI mapping failed — map the columns manually below.");
        } finally {
          setAiPending(false);
        }
      },
    });
  }

  function transformedRows() {
    return rows.map((row) => {
      const out: Record<string, string> = {};
      for (const t of TARGETS) {
        const src = mapping[t.key];
        if (src && row[src] != null) out[t.key] = row[src];
      }
      return out;
    });
  }

  function onCommit() {
    if (!mapping["company_name"]) {
      setError("company_name must be mapped.");
      return;
    }
    setError(null);
    start(async () => {
      const result = await commitLeadImport({
        client_id: clientId || null,
        rows: transformedRows(),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSummary({ inserted: result.inserted, skipped: result.skipped });
      setPhase("done");
      router.refresh();
    });
  }

  if (phase === "upload") {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">Step 1 — Upload CSV</CardTitle></CardHeader>
        <CardContent>
          {error && <Alert variant="destructive" className="mb-4">{error}</Alert>}
          <label
            htmlFor="csv"
            className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-border bg-muted/40 px-8 py-16 text-center hover:bg-muted"
          >
            <Upload className="mb-3 h-8 w-8 text-muted-foreground" />
            <p className="text-sm font-medium">Drop your CSV here, or click to choose</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Up to 2,000 rows per import. First row should be the header.
            </p>
            <input
              id="csv"
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onFile(file);
              }}
            />
          </label>
        </CardContent>
      </Card>
    );
  }

  if (phase === "mapping") {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              Step 2 — Map columns
              {aiPending && <span className="text-xs font-normal text-muted-foreground animate-pulse-soft">Aylek is thinking…</span>}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {aiWarning && (
              <Alert variant="default" className="border-amber-300/50 bg-amber-50 text-amber-900">
                {aiWarning}
              </Alert>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="client">Assign to client (optional)</Label>
              <Select value={clientId} onValueChange={setClientId}>
                <SelectTrigger id="client"><SelectValue placeholder="(unassigned)" /></SelectTrigger>
                <SelectContent>
                  {clients.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              {TARGETS.map((t) => (
                <div key={t.key} className="flex items-center gap-3">
                  <div className="w-44 shrink-0 text-sm">
                    {t.label} {t.required && <span className="text-destructive">*</span>}
                  </div>
                  <select
                    className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                    value={mapping[t.key] ?? ""}
                    onChange={(e) => setMapping({ ...mapping, [t.key]: e.target.value || null })}
                  >
                    <option value="">— skip —</option>
                    {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Preview ({rows.length} rows)</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-xs">
              <thead className="border-b text-left text-muted-foreground">
                <tr>
                  {TARGETS.map((t) => (
                    <th key={t.key} className="px-3 py-2 font-medium">{t.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {transformedRows().slice(0, 5).map((r, i) => (
                  <tr key={i}>
                    {TARGETS.map((t) => (
                      <td key={t.key} className="truncate px-3 py-1.5">{r[t.key] ?? "—"}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        {error && <Alert variant="destructive">{error}</Alert>}

        <div className="flex justify-between">
          <Button variant="outline" onClick={() => { setPhase("upload"); setError(null); }} disabled={commitPending}>
            ← Back
          </Button>
          <Button onClick={onCommit} disabled={commitPending || aiPending}>
            {commitPending ? "Importing…" : `Import ${rows.length} rows`}
          </Button>
        </div>
      </div>
    );
  }

  // done
  return (
    <Card>
      <CardContent className="py-12 text-center">
        <Check className="mx-auto h-10 w-10 text-emerald-500" />
        <p className="mt-3 text-lg font-medium">Imported {summary?.inserted ?? 0} leads</p>
        {summary && summary.skipped > 0 && (
          <p className="mt-1 text-sm text-muted-foreground">
            {summary.skipped} row{summary.skipped === 1 ? "" : "s"} skipped (duplicate email or missing company name)
          </p>
        )}
        <div className="mt-6 flex justify-center gap-3">
          <Button variant="outline" onClick={() => { setPhase("upload"); setRows([]); setHeaders([]); setMapping({}); setSummary(null); }}>
            Import another
          </Button>
          <Button onClick={() => router.push("/leads")}>View leads</Button>
        </div>
      </CardContent>
    </Card>
  );
}
