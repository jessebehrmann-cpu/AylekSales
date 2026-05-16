import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { translateIcp } from "@/lib/icp-translator";

// The translator's fallback path runs deterministically when
// ANTHROPIC_API_KEY isn't a valid sk-ant-… key. We force that here so
// the test doesn't make a real Claude call.
describe("translateIcp — deterministic fallback", () => {
  let prevKey: string | undefined;
  beforeEach(() => {
    prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "";
  });
  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = prevKey;
  });

  it("parses '20-200 employees' into Apollo's CSV format", async () => {
    const out = await translateIcp({
      icp: {
        industries: ["Hospitality"],
        company_size: "20-200 employees",
        target_titles: ["Operations Manager"],
        geography: ["Australia"],
      },
      playbookVersion: 1,
    });
    expect(out.apollo.organization_num_employees_ranges).toEqual(["20,200"]);
  });

  it("parses '100+' into 100,100000", async () => {
    const out = await translateIcp({
      icp: { company_size: "100+ employees" },
      playbookVersion: 1,
    });
    expect(out.apollo.organization_num_employees_ranges).toEqual(["100,100000"]);
  });

  it("infers manager seniority from a 'Manager' title", async () => {
    const out = await translateIcp({
      icp: { target_titles: ["Operations Manager"] },
      playbookVersion: 1,
    });
    expect(out.apollo.person_seniorities).toContain("manager");
  });

  it("infers c_suite from CEO/COO titles", async () => {
    const out = await translateIcp({
      icp: { target_titles: ["CEO", "Chief Operating Officer"] },
      playbookVersion: 1,
    });
    expect(out.apollo.person_seniorities).toContain("c_suite");
  });

  it("preserves the playbook version on the cached result", async () => {
    const out = await translateIcp({
      icp: { industries: ["SaaS"] },
      playbookVersion: 42,
    });
    expect(out.version).toBe(42);
  });

  it("returns a warning when Claude is unavailable", async () => {
    const out = await translateIcp({
      icp: { industries: ["SaaS"] },
      playbookVersion: 1,
    });
    expect(out.warning).toBeTruthy();
  });

  it("returns undefined for missing fields rather than empty arrays", async () => {
    const out = await translateIcp({
      icp: {},
      playbookVersion: 1,
    });
    expect(out.apollo.person_titles).toBeUndefined();
    expect(out.apollo.person_locations).toBeUndefined();
  });
});
