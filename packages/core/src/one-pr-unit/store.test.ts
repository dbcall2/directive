import { describe, expect, it } from "vitest";
import { mintOnePrUnitGrant } from "./mint.js";
import { InProcessAppStore } from "./simulator.js";
import { listOnePrUnitGrants, loadOnePrUnitGrant, writeOnePrUnitGrant } from "./store.js";
import { DISK_STORE_NOT_SOT, type OnePrUnitClaim } from "./types.js";

describe("one-pr-unit App store facade", () => {
  it("looks up minted claims and refuses disk writes", () => {
    const store = new InProcessAppStore();
    mintOnePrUnitGrant({
      store,
      id: "unit-a",
      actor: "dbcall2",
      approvalRef: "ref",
      rationale: "why",
      origins: [
        { repo: "o/r", issueId: 1 },
        { repo: "o/r", issueId: 2 },
      ],
      repo: "o/r",
    });
    expect(loadOnePrUnitGrant("ignored", "unit-a", store)?.id).toBe("unit-a");
    expect(listOnePrUnitGrants("ignored", store)).toHaveLength(1);
    expect(() => writeOnePrUnitGrant("ignored", store.getById("unit-a") as OnePrUnitClaim)).toThrow(
      DISK_STORE_NOT_SOT,
    );
  });
});
