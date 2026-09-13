import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { mintOnePrUnitGrant } from "./mint.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

describe("mintOnePrUnitGrant", () => {
  it("refuses a single origin", () => {
    const project = mkdtempSync(join(tmpdir(), "mint-"));
    temps.push(project);
    expect(() =>
      mintOnePrUnitGrant({
        projectRoot: project,
        id: "x",
        actor: "dbcall2",
        approvalRef: "ref",
        rationale: "why",
        origins: [{ repo: "o/r", issueId: 1 }],
        repo: "o/r",
        singleUse: true,
      }),
    ).toThrow(/at least two origins/);
  });

  it("refuses unbound non-single-use", () => {
    const project = mkdtempSync(join(tmpdir(), "mint-"));
    temps.push(project);
    expect(() =>
      mintOnePrUnitGrant({
        projectRoot: project,
        id: "x",
        actor: "dbcall2",
        approvalRef: "ref",
        rationale: "why",
        origins: [
          { repo: "o/r", issueId: 1 },
          { repo: "o/r", issueId: 2 },
        ],
        repo: "o/r",
      }),
    ).toThrow(/binding or single-use/);
  });
});
