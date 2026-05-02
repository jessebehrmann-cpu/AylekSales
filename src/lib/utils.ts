import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(amount: number | null | undefined, currency = "AUD") {
  if (amount == null) return "—";
  return new Intl.NumberFormat("en-AU", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
}

export function formatDate(date: string | Date | null | undefined) {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-AU", { dateStyle: "medium" }).format(d);
}

export function formatDateTime(date: string | Date | null | undefined) {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" }).format(d);
}
