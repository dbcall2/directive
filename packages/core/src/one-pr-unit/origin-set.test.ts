import { describe, expect, it } from "vitest";
import {
  exactOriginSetEquals,
  formatOriginSet,
  normalizeOrigin,
  originKey,
  uniqueOrigins,
} from "./origin-set.js";

describe("origin-set", () => {
  it("normalizes repo case and exact-set equality", () => {
    const a = [normalizeOrigin("DeftAI/Directive", 1), normalizeOrigin("deftai/directive", 2)];
    const b = uniqueOrigins([
      { repo: "deftai/directive", issueId: 2 },
      { repo: "deftai/directive", issueId: 1 },
      { repo: "deftai/directive", issueId: 1 },
    ]);
    expect(exactOriginSetEquals(a, b)).toBe(true);
    expect(originKey(a[0]!)).toBe("deftai/directive#1");
    expect(formatOriginSet(a)).toContain("deftai/directive#1");
  });

  it("rejects overlap as equality", () => {
    expect(
      exactOriginSetEquals(
        [{ repo: "o/r", issueId: 1 }],
        [
          { repo: "o/r", issueId: 1 },
          { repo: "o/r", issueId: 2 },
        ],
      ),
    ).toBe(false);
  });
});
