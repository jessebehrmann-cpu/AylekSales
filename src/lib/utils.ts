import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(amount: number | null | undefined, currency = "AUD") {
  if (amount == null) return "—";
  return new Intl.NumberFormat("en-AU", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
}

/**
 * Date formatting is hand-rolled rather than going through Intl.DateTimeFormat
 * so server (Node ICU) and client (browser ICU) produce byte-identical output.
 * `Intl.DateTimeFormat` with `dateStyle`/`timeStyle` switches separators
 * between ICU versions ("9 May 2026, 9:55 pm" vs "9 May 2026 at 9:55 pm")
 * which causes React hydration errors. Keeping it deterministic.
 *
 * Output format: `9 May 2026` for date, `9 May 2026, 9:55 pm` for date+time.
 * Uses the viewer's local timezone (browser) or server timezone (SSR);
 * because we serialise both sides with the same logic, the strings match.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function toDate(value: string | Date): Date {
  return typeof value === "string" ? new Date(value) : value;
}

export function formatDate(date: string | Date | null | undefined): string {
  if (!date) return "—";
  const d = toDate(date);
  if (isNaN(d.getTime())) return "—";
  // Local time on both server and client. The Node process running this app
  // and the browser viewing it are assumed to share a timezone (true for
  // local dev). For production, swap callers to <LocalTime/> if they need
  // viewer-local times in a UTC server context.
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function formatDateTime(date: string | Date | null | undefined): string {
  if (!date) return "—";
  const d = toDate(date);
  if (isNaN(d.getTime())) return "—";
  const day = d.getDate();
  const month = MONTHS[d.getMonth()];
  const year = d.getFullYear();
  let hour = d.getHours();
  const minute = String(d.getMinutes()).padStart(2, "0");
  const ampm = hour >= 12 ? "pm" : "am";
  hour = hour % 12 || 12;
  return `${day} ${month} ${year}, ${hour}:${minute} ${ampm}`;
}
