import { describe, it, expect } from "vitest";
import { computeLeadStatus } from "@/lib/lead-status";
import type { SalesProcessStage } from "@/lib/supabase/types";

const humanStage: SalesProcessStage = {
  id: "have_meeting",
  name: "Have meeting",
  description: "",
  agent: "human",
  condition: null,
};
const agentStage: SalesProcessStage = {
  id: "outreach",
  name: "Outreach",
  description: "",
  agent: "outreach-01",
  condition: null,
};

describe("computeLeadStatus — every priority branch", () => {
  it("returns lost when leadStage === 'lost'", () => {
    expect(
      computeLeadStatus({
        approvalStatus: "approved",
        leadStage: "lost",
        currentStage: null,
        proposalSent: false,
        proposalPending: false,
      }),
    ).toBe("lost");
  });

  it("returns lost when leadStage === 'unsubscribed'", () => {
    expect(
      computeLeadStatus({
        approvalStatus: "approved",
        leadStage: "unsubscribed",
        currentStage: null,
        proposalSent: false,
        proposalPending: false,
      }),
    ).toBe("lost");
  });

  it("returns lost when approvalStatus === 'rejected'", () => {
    expect(
      computeLeadStatus({
        approvalStatus: "rejected",
        leadStage: "new",
        currentStage: agentStage,
        proposalSent: false,
        proposalPending: false,
      }),
    ).toBe("lost");
  });

  it("returns won when leadStage === 'won' (before approval check)", () => {
    expect(
      computeLeadStatus({
        approvalStatus: "approved",
        leadStage: "won",
        currentStage: null,
        proposalSent: false,
        proposalPending: false,
      }),
    ).toBe("won");
  });

  it("returns pending_review when approvalStatus === 'pending_approval' AND not lost/won", () => {
    expect(
      computeLeadStatus({
        approvalStatus: "pending_approval",
        leadStage: "new",
        currentStage: agentStage,
        proposalSent: false,
        proposalPending: false,
      }),
    ).toBe("pending_review");
  });

  it("returns awaiting_human when current stage is human-owned", () => {
    expect(
      computeLeadStatus({
        approvalStatus: "approved",
        leadStage: "meeting_booked",
        currentStage: humanStage,
        proposalSent: false,
        proposalPending: false,
      }),
    ).toBe("awaiting_human");
  });

  it("returns proposal_sent when proposalSent flag is true", () => {
    expect(
      computeLeadStatus({
        approvalStatus: "approved",
        leadStage: "quoted",
        currentStage: agentStage,
        proposalSent: true,
        proposalPending: false,
      }),
    ).toBe("proposal_sent");
  });

  it("returns proposal_pending_review when only proposalPending is true", () => {
    expect(
      computeLeadStatus({
        approvalStatus: "approved",
        leadStage: "quoted",
        currentStage: agentStage,
        proposalSent: false,
        proposalPending: true,
      }),
    ).toBe("proposal_pending_review");
  });

  it("returns active as the default fallback", () => {
    expect(
      computeLeadStatus({
        approvalStatus: "approved",
        leadStage: "contacted",
        currentStage: agentStage,
        proposalSent: false,
        proposalPending: false,
      }),
    ).toBe("active");
  });

  it("priority: lost wins over won when both apply (rejected + won is still lost? no — lost is reachable only via lost/unsubscribed/rejected)", () => {
    // The function's lost branch fires on rejected even if leadStage is won.
    expect(
      computeLeadStatus({
        approvalStatus: "rejected",
        leadStage: "won",
        currentStage: null,
        proposalSent: false,
        proposalPending: false,
      }),
    ).toBe("lost");
  });
});
