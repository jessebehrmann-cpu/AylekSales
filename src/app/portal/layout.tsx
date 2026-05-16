import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Aylek — your sales pipeline",
};

/**
 * Portal layout — for client_owner users to view their own client(s)'
 * pipeline. Admins also see this layout when they hit /portal but it's
 * primarily a client-owner experience.
 *
 * Auth: must be signed in. client_owner with empty client_ids gets a
 * friendly "no scopes yet" page so they don't see a blank dashboard.
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const u = await getCurrentUser();
  if (!u) redirect("/login?next=/portal");
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-primary" />
            <span className="text-sm font-semibold tracking-tight">Aylek Sales</span>
            <span className="ml-2 text-xs text-muted-foreground">Client portal</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>{u.profile?.email ?? u.auth.email}</span>
            <Link href="/logout" className="hover:underline">
              Sign out
            </Link>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
    </div>
  );
}
