import { describe, expect, it } from "vitest";
import { evidenceSatisfiesImplementationApproval } from "../authz/origin.js";
import type { GrantOrigin } from "../authz/types.js";
import { extractIntentCloserSet } from "./closer-set.js";
import { evaluateOnePrUnit } from "./evaluate.js";
import { mintOnePrUnitGrant } from "./mint.js";
import { InProcessAppStore } from "./simulator.js";
import { loadOnePrUnitGrant } from "./store.js";
import {
  MISSING_ONE_PR_UNIT_CONSENT,
  ONE_PR_UNIT_SCHEMA,
  type OnePrUnitClaim,
  OPAQUE_ID_NOT_BEARER,
  type OriginRef,
  SERIALIZE_N_PRS,
} from "./types.js";

const REPO = "deftai/directive";
const FIVE: OriginRef[] = [4204, 4218, 4161, 3918, 3849].map((issueId) => ({
  repo: REPO,
  issueId,
}));

function humanOrigin(overrides: Partial<GrantOrigin> = {}): GrantOrigin {
  return {
    kind: "operator-cli",
    actor: "dbcall2",
    mintedAt: "2026-09-14T00:00:00Z",
    mintedVia: "authz:grant/one-pr-unit",
    eventRef: "operator chat",
    ...overrides,
  };
}

function claim(overrides: Partial<OnePrUnitClaim> = {}): OnePrUnitClaim {
  return {
    schema: ONE_PR_UNIT_SCHEMA,
    id: "unit-five",
    origin: humanOrigin(),
    approvalRef: "operator-approved",
    rationale: "five origins close together",
    origins: FIVE,
    repo: REPO,
    state: "bound",
    prNodeId: "PR_kwDOFive",
    mintedBy: "dbcall2",
    mintedAt: "2026-09-14T00:00:00Z",
    expiresAt: "2026-09-15T00:00:00Z",
    boundAt: "2026-09-14T00:01:00Z",
    spentAt: null,
    revokedAt: null,
    expiredAt: null,
    ...overrides,
  };
}

describe("evaluateOnePrUnit", () => {
  it("allows empty closer-set", () => {
    const d = evaluateOnePrUnit({ closerSet: [], grant: null });
    expect(d.ok).toBe(true);
    expect(d.code).toBe("allow-empty");
  });

  it("allows a single origin without a grant", () => {
    const d = evaluateOnePrUnit({
      closerSet: [{ repo: REPO, issueId: 4494 }],
      grant: null,
    });
    expect(d.ok).toBe(true);
    expect(d.code).toBe("allow-single-origin");
  });

  it("fails closed on five origins with no grant and names missing consent", () => {
    const d = evaluateOnePrUnit({ closerSet: FIVE, grant: null });
    expect(d.ok).toBe(false);
    expect(d.code).toBe("deny-missing-consent");
    expect(d.message).toContain(MISSING_ONE_PR_UNIT_CONSENT);
  });

  it("does not treat #1378 fields as consent", () => {
    expect(
      evidenceSatisfiesImplementationApproval({
        allocationContext: {
          allocation_plan_id: "plan",
          batching_rationale: "overlap",
          operator_approval_evidence: "implement 4204 4218",
        },
      }),
    ).toBe(false);
    const d = evaluateOnePrUnit({ closerSet: FIVE, grant: null });
    expect(d.ok).toBe(false);
  });

  it("opaque id without a store hit is not a bearer", () => {
    const d = evaluateOnePrUnit({
      closerSet: FIVE,
      grant: null,
      presentedIdWithoutStore: true,
    });
    expect(d.ok).toBe(false);
    expect(d.code).toBe("deny-not-bearer");
    expect(d.message).toContain(OPAQUE_ID_NOT_BEARER);
  });

  it("passes the same five origins with an App-store bound claim", () => {
    const d = evaluateOnePrUnit({
      closerSet: FIVE,
      grant: claim(),
      binding: { repo: REPO, prNodeId: "PR_kwDOFive" },
    });
    expect(d.ok).toBe(true);
    expect(d.code).toBe("allow-granted");
  });

  it("rejects agent-authored allocation origin", () => {
    const d = evaluateOnePrUnit({
      closerSet: FIVE,
      grant: claim({ origin: humanOrigin({ kind: "allocation-context", actor: "agent" }) }),
      binding: { repo: REPO, prNodeId: "PR_kwDOFive" },
    });
    expect(d.ok).toBe(false);
    expect(d.code).toBe("deny-origin-kind");
  });

  it("rejects overlap (superset) grants — exact-set only", () => {
    const d = evaluateOnePrUnit({
      closerSet: FIVE.slice(0, 2),
      grant: claim(),
      binding: { repo: REPO, prNodeId: "PR_kwDOFive" },
    });
    expect(d.ok).toBe(false);
    expect(d.code).toBe("deny-origin-mismatch");
  });

  it("rejects a later presentation from a different PR node id", () => {
    expect(
      evaluateOnePrUnit({
        closerSet: FIVE,
        grant: claim(),
        binding: { repo: REPO, prNodeId: "PR_other" },
      }).code,
    ).toBe("deny-binding");
  });

  it("rejects revoked, spent, expired", () => {
    expect(
      evaluateOnePrUnit({
        closerSet: FIVE,
        grant: claim({ state: "revoked", revokedAt: "2026-09-14T01:00:00Z" }),
        binding: { repo: REPO, prNodeId: "PR_kwDOFive" },
      }).code,
    ).toBe("deny-revoked");
    expect(
      evaluateOnePrUnit({
        closerSet: FIVE,
        grant: claim({ state: "spent", spentAt: "2026-09-14T01:00:00Z" }),
        binding: { repo: REPO, prNodeId: "PR_kwDOFive" },
      }).code,
    ).toBe("deny-spent");
    expect(
      evaluateOnePrUnit({
        closerSet: FIVE,
        grant: claim({ state: "expired", expiredAt: "2026-09-15T00:00:00Z" }),
        binding: { repo: REPO, prNodeId: "PR_kwDOFive" },
      }).code,
    ).toBe("deny-expired");
  });
});

describe("extractIntentCloserSet comma-list", () => {
  it("counts Closes #4204, #4218, … as multiple origins", () => {
    const set = extractIntentCloserSet(["Closes #4204, #4218, #4161, #3918, #3849"], REPO);
    expect(set.map((o) => o.issueId).sort((a, b) => a - b)).toEqual([3849, 3918, 4161, 4204, 4218]);
  });

  it("does not treat a first-#N-only detector as the closer-set", () => {
    const set = extractIntentCloserSet(["Closes #4204, #4218"], REPO);
    expect(set).toHaveLength(2);
  });
});

describe("mintOnePrUnitGrant App store", () => {
  it("writes an operator-cli reserved claim into the App store, not disk", () => {
    const store = new InProcessAppStore();
    const minted = mintOnePrUnitGrant({
      store,
      id: "unit-five",
      actor: "dbcall2",
      approvalRef: "operator-approved 2026-09-14",
      rationale: "five origins",
      origins: FIVE,
      repo: REPO,
    });
    expect(minted.origin.kind).toBe("operator-cli");
    expect(minted.state).toBe("reserved");
    expect(minted.prNodeId).toBeNull();
    expect(loadOnePrUnitGrant("/tmp/not-a-store", "unit-five", store)?.id).toBe("unit-five");
  });
});

describe("overlap serializes N PRs", () => {
  it("names serialize N PRs and denies combine-as-consent", () => {
    expect(SERIALIZE_N_PRS).toMatch(/serialize N PRs/);
    expect(SERIALIZE_N_PRS).toMatch(/not one-PR-unit consent/);
  });
});
