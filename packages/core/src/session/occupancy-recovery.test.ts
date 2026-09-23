import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OccupancyCeremonyEligibility } from "./occupancy.js";
import {
  applyOccupancyEligibilityToDenial,
  formatOccupancyAwareRitualRecovery,
  occupancyAwareDenialMessage,
  SHELL_COVERAGE_HONESTY,
} from "./occupancy-recovery.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function admitted(): OccupancyCeremonyEligibility {
  return {
    admitCeremony: true,
    occupancyCase: "absent",
    sessionId: "solo",
    occupantId: null,
    restrictedPrimary: false,
    denialMessage: null,
  };
}

function refused(
  overrides: Partial<OccupancyCeremonyEligibility> = {},
): OccupancyCeremonyEligibility {
  return {
    admitCeremony: false,
    occupancyCase: "restricted-primary",
    sessionId: "solo",
    occupantId: null,
    restrictedPrimary: true,
    denialMessage:
      "occupancy refuses a mutation claim on the primary checkout. " +
      "Run `deft session:start --primary-claim-exception=operator-default-branch --session-id=solo`.",
    ...overrides,
  };
}

describe("occupancy-aware ritual recovery (#4290)", () => {
  it("admits session:ready and names shell coverage", () => {
    const text = formatOccupancyAwareRitualRecovery(admitted(), "rearm");
    expect(text).toContain("session:ready");
    expect(text).toContain("one-shot");
    expect(text).toContain(SHELL_COVERAGE_HONESTY);
  });

  it("strips embedded ritual commands from the whole denial, not only the suffix", () => {
    const whole =
      "Directive denied Write: stale. Run `deft session:start --rearm` to re-arm " +
      "(or `deft session:start` for a full cold ceremony). " +
      "Recovery: run `deft session:ready` (one-shot).";
    const rewritten = applyOccupancyEligibilityToDenial(whole, refused(), "rearm");
    expect(rewritten).not.toMatch(/session:ready/);
    expect(rewritten).not.toMatch(/session:start --rearm/);
    expect(rewritten).toContain("primary-claim-exception=operator-default-branch");
    expect(rewritten).toContain(SHELL_COVERAGE_HONESTY);
  });

  it("keeps the trusted exception command and the cache-fresh defer form", () => {
    const text =
      "Use `deft session:start --primary-claim-exception=operator-default-branch`. " +
      "Soft path (audited): `deft session:start -- --defer cache_fresh=<reason>`.";
    const rewritten = applyOccupancyEligibilityToDenial(text, refused(), "cold");
    expect(rewritten).toContain("primary-claim-exception=operator-default-branch");
    expect(rewritten).toContain("session:start -- --defer cache_fresh=<reason>");
  });

  it("does not duplicate session:ready when the one-shot recovery is already present", () => {
    const message =
      "step failed. Recovery: run `deft session:ready` (one-shot: session:start + gated ritual).";
    const rewritten = applyOccupancyEligibilityToDenial(message, admitted(), "cold");
    expect(rewritten.match(/session:ready/g)?.length).toBe(1);
    expect(rewritten).toContain(SHELL_COVERAGE_HONESTY);
  });

  it("formats refuse-mint with empty denial as shell honesty only", () => {
    const text = formatOccupancyAwareRitualRecovery(
      refused({ denialMessage: null, occupancyCase: "refuse-mint" }),
      "cold",
    );
    expect(text).toBe(SHELL_COVERAGE_HONESTY);
  });

  it("occupancyAwareDenialMessage admits a vacant uncontended tree", () => {
    const root = mkdtempSync(join(tmpdir(), "occ-rec-"));
    temps.push(root);
    mkdirSync(join(root, ".deft"), { recursive: true });
    const text = occupancyAwareDenialMessage(
      root,
      "session ritual state is stale (older than 4h).",
      { sessionId: "solo" },
      "rearm",
    );
    expect(text).toContain("session:ready");
    expect(text).toContain(SHELL_COVERAGE_HONESTY);
  });
});
