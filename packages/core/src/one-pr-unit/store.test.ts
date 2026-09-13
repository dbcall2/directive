import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { mintOnePrUnitGrant } from "./mint.js";
import { listOnePrUnitGrants, loadOnePrUnitGrant, parseOnePrUnitGrant } from "./store.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

describe("one-pr-unit store", () => {
  it("round-trips a minted grant and rejects agent-origin JSON", () => {
    const project = mkdtempSync(join(tmpdir(), "store-"));
    temps.push(project);
    mintOnePrUnitGrant({
      projectRoot: project,
      id: "unit-a",
      actor: "dbcall2",
      approvalRef: "ref",
      rationale: "why",
      origins: [
        { repo: "o/r", issueId: 1 },
        { repo: "o/r", issueId: 2 },
      ],
      repo: "o/r",
      branch: "feat/x",
    });
    expect(loadOnePrUnitGrant(project, "unit-a")?.id).toBe("unit-a");
    expect(listOnePrUnitGrants(project)).toHaveLength(1);
    expect(parseOnePrUnitGrant({ schema: "nope" })).toBeNull();
    expect(
      parseOnePrUnitGrant({
        schema: "deft.one-pr-unit.v1",
        id: "bad",
        origin: {
          kind: "allocation-context",
          actor: "agent",
          mintedAt: "2026-09-13T00:00:00Z",
          mintedVia: "self",
          eventRef: null,
        },
        approvalRef: "x",
        rationale: "y",
        origins: [
          { repo: "o/r", issueId: 1 },
          { repo: "o/r", issueId: 2 },
        ],
        repo: "o/r",
        branch: "b",
        prNumber: null,
        singleUse: false,
        usedAt: null,
        revokedAt: null,
        mintedAt: "2026-09-13T00:00:00Z",
      }),
    ).toBeNull();
  });
});
