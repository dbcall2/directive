import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { GrantOrigin } from "../authz/types.js";
import { extractIntentCloserSet } from "./closer-set.js";
import { evaluateOnePrUnit } from "./evaluate.js";
import { mintOnePrUnitGrant } from "./mint.js";
import { loadOnePrUnitGrant } from "./store.js";
import {
  MISSING_ONE_PR_UNIT_CONSENT,
  ONE_PR_UNIT_SCHEMA,
  type OnePrUnitGrant,
  type OriginRef,
  SERIALIZE_N_PRS,
} from "./types.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

const REPO = "deftai/directive";
const FIVE: OriginRef[] = [4204, 4218, 4161, 3918, 3849].map((issueId) => ({
  repo: REPO,
  issueId,
}));

function humanOrigin(overrides: Partial<GrantOrigin> = {}): GrantOrigin {
  return {
    kind: "operator-cli",
    actor: "dbcall2",
    mintedAt: "2026-09-13T20:00:00Z",
    mintedVia: "one-pr-unit:mint",
    eventRef: "operator chat 2026-09-13",
    ...overrides,
  };
}

function grant(overrides: Partial<OnePrUnitGrant> = {}): OnePrUnitGrant {
  return {
    schema: ONE_PR_UNIT_SCHEMA,
    id: "unit-five",
    origin: humanOrigin(),
    approvalRef: "operator-approved one-PR-unit 2026-09-13",
    rationale: "five origins close together",
    origins: FIVE,
    repo: REPO,
    branch: "feat/batch",
    prNumber: null,
    singleUse: false,
    usedAt: null,
    revokedAt: null,
    mintedAt: "2026-09-13T20:00:00Z",
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

  it("passes the same five origins with an operator-origin grant", () => {
    const d = evaluateOnePrUnit({
      closerSet: FIVE,
      grant: grant(),
      binding: { repo: REPO, branch: "feat/batch" },
    });
    expect(d.ok).toBe(true);
    expect(d.code).toBe("allow-granted");
  });

  it("rejects agent-authored allocation origin", () => {
    const d = evaluateOnePrUnit({
      closerSet: FIVE,
      grant: grant({ origin: humanOrigin({ kind: "allocation-context", actor: "agent" }) }),
      binding: { repo: REPO, branch: "feat/batch" },
    });
    expect(d.ok).toBe(false);
    expect(d.code).toBe("deny-origin-kind");
    expect(d.message).toContain(MISSING_ONE_PR_UNIT_CONSENT);
  });

  it("rejects overlap (superset) grants — exact-set only", () => {
    const d = evaluateOnePrUnit({
      closerSet: FIVE.slice(0, 2),
      grant: grant(),
      binding: { repo: REPO, branch: "feat/batch" },
    });
    expect(d.ok).toBe(false);
    expect(d.code).toBe("deny-origin-mismatch");
  });

  it("does not consult UAT state", () => {
    const d = evaluateOnePrUnit({
      closerSet: FIVE,
      grant: grant(),
      binding: { repo: REPO, branch: "feat/batch" },
    });
    expect(d.ok).toBe(true);
    expect(JSON.stringify(d)).not.toMatch(/uat/i);
  });

  it("rejects revoked, spent, unbound, and binding mismatches", () => {
    expect(
      evaluateOnePrUnit({
        closerSet: FIVE,
        grant: grant({ revokedAt: "2026-09-13T21:00:00Z" }),
        binding: { repo: REPO, branch: "feat/batch" },
      }).code,
    ).toBe("deny-revoked");
    expect(
      evaluateOnePrUnit({
        closerSet: FIVE,
        grant: grant({ singleUse: true, usedAt: "2026-09-13T21:00:00Z", branch: null }),
        binding: { repo: REPO },
      }).code,
    ).toBe("deny-spent");
    expect(
      evaluateOnePrUnit({
        closerSet: FIVE,
        grant: grant({ branch: null, prNumber: null, singleUse: false }),
        binding: { repo: REPO },
      }).code,
    ).toBe("deny-unbound");
    expect(
      evaluateOnePrUnit({
        closerSet: FIVE,
        grant: grant(),
        binding: { repo: REPO, branch: "other" },
      }).code,
    ).toBe("deny-binding");
    expect(
      evaluateOnePrUnit({
        closerSet: FIVE,
        grant: grant({ branch: null, prNumber: 4492 }),
        binding: { repo: REPO, prNumber: 1 },
      }).code,
    ).toBe("deny-binding");
    expect(
      evaluateOnePrUnit({
        closerSet: FIVE,
        grant: grant(),
        binding: { repo: "other/repo", branch: "feat/batch" },
      }).code,
    ).toBe("deny-binding");
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

describe("mintOnePrUnitGrant", () => {
  it("writes an operator-cli grant and reloads it", () => {
    const project = mkdtempSync(join(tmpdir(), "one-pr-unit-"));
    temps.push(project);
    const minted = mintOnePrUnitGrant({
      projectRoot: project,
      id: "unit-five",
      actor: "dbcall2",
      approvalRef: "operator-approved 2026-09-13",
      rationale: "five origins",
      origins: FIVE,
      repo: REPO,
      branch: "feat/batch",
    });
    expect(minted.origin.kind).toBe("operator-cli");
    const loaded = loadOnePrUnitGrant(project, "unit-five");
    expect(loaded?.id).toBe("unit-five");
    expect(loaded?.origins).toHaveLength(5);
  });
});

describe("overlap serializes N PRs", () => {
  it("names serialize N PRs and denies combine-as-consent", () => {
    expect(SERIALIZE_N_PRS).toMatch(/serialize N PRs/);
    expect(SERIALIZE_N_PRS).toMatch(/not one-PR-unit consent/);
  });
});
