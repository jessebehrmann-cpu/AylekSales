import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { AppUser } from "@/lib/supabase/types";

/** Returns the auth.users row + the public.users row, or null. */
export async function getCurrentUser() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("users")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  return { auth: user, profile: profile as AppUser | null };
}

/** Use in server components / actions where unauthed should bounce to /login. */
export async function requireUser() {
  const u = await getCurrentUser();
  if (!u) redirect("/login");
  return u;
}

/** Use in admin-only mutations — throws so the action surfaces the error. */
export async function requireAdmin() {
  const u = await requireUser();
  if (u.profile?.role !== "admin") {
    throw new Error("Admins only");
  }
  return u;
}
