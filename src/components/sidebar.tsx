"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Building2,
  Users,
  Send,
  Inbox,
  Calendar,
  MessageSquare,
  Settings,
  BookOpen,
  Hand,
} from "lucide-react";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/clients", label: "Clients", icon: Building2 },
  { href: "/leads", label: "Leads", icon: Users },
  { href: "/campaigns", label: "Campaigns", icon: Send },
  { href: "/playbooks", label: "Playbooks", icon: BookOpen },
  { href: "/approvals", label: "Approvals", icon: Hand, badgeKey: "approvals" as const },
  { href: "/inbound", label: "Inbound", icon: Inbox },
  { href: "/meetings", label: "Meetings", icon: Calendar },
  { href: "/query", label: "Query", icon: MessageSquare },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar({ pendingApprovals = 0 }: { pendingApprovals?: number }) {
  const pathname = usePathname();

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-800 bg-sidebar text-sidebar-foreground md:flex">
      <div className="flex h-16 items-center px-6 text-lg font-semibold tracking-tight">
        <span className="text-sidebar-accent">Aylek</span>
        <span className="ml-1.5 text-sidebar-foreground/90">Sales</span>
      </div>
      <nav className="flex-1 space-y-1 px-3 py-4">
        {NAV.map(({ href, label, icon: Icon, badgeKey }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          const showBadge = badgeKey === "approvals" && pendingApprovals > 0;
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-sidebar-accent/15 text-sidebar-accent"
                  : "text-sidebar-foreground/70 hover:bg-white/5 hover:text-sidebar-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              <span className="flex-1">{label}</span>
              {showBadge && (
                <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                  {pendingApprovals}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-slate-800 p-4 text-xs text-sidebar-foreground/50">
        v0.1.0 · foundation
      </div>
    </aside>
  );
}
