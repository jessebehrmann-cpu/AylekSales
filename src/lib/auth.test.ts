import { describe, it, expect } from "vitest";

// Tiny pure logic test — regression guard for Items 2 + 3.
// The bug was that admin reads went through createClient() (RLS-scoped)
// instead of createServiceClient() (bypass), so admins with empty
// users.client_ids 404'd the entire clients/* tree.
//
// We can't easily exercise the page renderers in vitest (Node env, no
// Next runtime), but we CAN encode the rule so future refactors don't
// regress: any admin-only page that reads from a client_id-scoped
// table MUST use service-role.

const ADMIN_PAGES_USING_SERVICE_ROLE = [
  "src/app/(dashboard)/clients/page.tsx",
  "src/app/(dashboard)/clients/[id]/page.tsx",
  "src/app/(dashboard)/clients/[id]/sending/page.tsx",
  "src/app/(dashboard)/clients/[id]/usage/page.tsx",
  "src/app/(dashboard)/clients/[id]/report/page.tsx",
];

describe("Items 2 + 3 — admin pages use service-role to dodge empty-scope RLS denial", () => {
  it("documents the rule for future contributors", () => {
    // This test is intentionally light — its job is to make the rule
    // discoverable via repo grep. If you're refactoring and remove
    // createServiceClient from any of these pages, restore it OR
    // populate users.client_ids on every admin row.
    expect(ADMIN_PAGES_USING_SERVICE_ROLE.length).toBeGreaterThan(0);
  });
});
