/**
 * Thin presentational wrapper around the computed lead status. All status
 * derivation lives in `lib/lead-status.ts` — single source of truth.
 */

import { Badge } from "@/components/ui/badge";
import {
  computeLeadStatus,
  STATUS_META,
  type ComputedStatus,
} from "@/lib/lead-status";

export { computeLeadStatus };
export type { ComputedStatus };

export function LeadStatusPill({ status }: { status: ComputedStatus }) {
  const meta = STATUS_META[status];
  return <Badge className={meta.klass}>{meta.label}</Badge>;
}
