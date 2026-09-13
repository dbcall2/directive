import { describe, expect, it } from "vitest";
import {
  MISSING_ONE_PR_UNIT_CONSENT,
  ONE_PR_UNIT_SCHEMA,
  SERIALIZE_N_PRS,
  SOLO_MULTI_COHORT_CONFIG,
} from "./types.js";

describe("one-pr-unit types", () => {
  it("exports the schema and remediation strings", () => {
    expect(ONE_PR_UNIT_SCHEMA).toBe("deft.one-pr-unit.v1");
    expect(MISSING_ONE_PR_UNIT_CONSENT).toMatch(/missing one-PR-unit consent/);
    expect(SERIALIZE_N_PRS).toMatch(/serialize N PRs/);
    expect(SOLO_MULTI_COHORT_CONFIG).toMatch(/cohort_vbriefs/);
  });
});
