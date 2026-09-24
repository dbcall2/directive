import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readOccupancy } from "./occupancy.js";
import { runSiblingFenceClaim } from "./occupancy-sibling-fence-worker.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

describe("occupancy-sibling-fence-worker", () => {
  it("persists a mutation claim on a vacant tree", () => {
    const root = mkdtempSync(join(tmpdir(), "occ-fence-worker-"));
    temps.push(root);
    mkdirSync(join(root, ".deft"), { recursive: true });
    const claimed = runSiblingFenceClaim(root, "solo");
    expect(claimed.code).toBe(0);
    expect(claimed.action).toBe("claimed");
    expect(claimed.sessionId).toBe("solo");
    expect(claimed.claimedAt).not.toBeNull();
    expect(readOccupancy(root)?.sessionId).toBe("solo");
  });
});
