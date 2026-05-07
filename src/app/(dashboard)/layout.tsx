import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { count: pendingApprovals } = await supabase
    .from("approvals")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");

  return (
    <div className="flex h-screen w-full overflow-hidden bg-muted/20">
      <Sidebar pendingApprovals={pendingApprovals ?? 0} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar email={user.email ?? null} />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
