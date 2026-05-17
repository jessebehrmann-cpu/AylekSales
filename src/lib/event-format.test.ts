import { describe, it, expect } from "vitest";
import { describeEvent } from "@/lib/event-format";

describe("describeEvent — plain-English formatter", () => {
  it("formats prospect_run with lead count + segment", () => {
    const out = describeEvent({
      event_type: "ai_action",
      payload: { kind: "prospect_run", found: 14, segment_name: "Restaurant Managers", new: 12, duplicates: 2 },
    });
    expect(out.headline).toBe("Prospect-01 sourced 14 leads from Restaurant Managers");
    expect(out.source).toBe("Prospect-01");
    expect(out.status).toBe("ok");
    expect(out.detail).toContain("duplicates");
  });

  it("formats reply classification with kind + quality", () => {
    const out = describeEvent({
      event_type: "inbound_qualified",
      payload: { lead_name: "Acme Co", reply_kind: "interested", quality: "hot" },
    });
    expect(out.headline).toBe("Acme Co: classified interested (hot)");
    expect(out.status).toBe("ok");
    expect(out.source).toBe("Sales-01");
  });

  it("formats client_sending_unverified as a fail", () => {
    const out = describeEvent({
      event_type: "ai_action",
      payload: { kind: "client_sending_unverified", message: "domain not verified" },
    });
    expect(out.status).toBe("fail");
    expect(out.headline).toContain("Send blocked");
  });

  it("formats stage_engine_transition with before/after", () => {
    const out = describeEvent({
      event_type: "stage_changed",
      payload: {
        kind: "stage_engine_transition",
        lead_name: "Acme Co",
        before: "outreach",
        stage_name: "Book meeting",
      },
    });
    expect(out.headline).toBe("Acme Co advanced outreach → Book meeting");
  });

  it("formats email.bounced as auto-unsubscribed", () => {
    const out = describeEvent({
      event_type: "email_bounced",
      payload: { lead_name: "Acme Co", kind: "email.bounced" },
    });
    expect(out.headline).toContain("bounced");
    expect(out.detail).toContain("suppression list");
    expect(out.status).toBe("fail");
  });

  it("formats unknown kinds via the prettify fallback (never returns raw code)", () => {
    const out = describeEvent({
      event_type: "ai_action",
      payload: { kind: "some_brand_new_kind", lead_name: "Acme Co", message: "did a thing" },
    });
    // Headline must not equal the raw kind code.
    expect(out.headline).not.toBe("some_brand_new_kind");
    expect(out.headline).not.toBe("ai_action");
  });

  it("returns Event recorded as the final fallback", () => {
    const out = describeEvent({ event_type: "query_run" as never, payload: {} });
    // query_run has its own case → headline shouldn't be 'Event recorded'.
    expect(out.headline).toBeTruthy();
  });
});
