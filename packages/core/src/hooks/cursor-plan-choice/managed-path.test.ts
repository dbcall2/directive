import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cursorPlanChoiceStoreRoot, isCursorPlanChoiceManagedPath } from "./managed-path.js";

describe("isCursorPlanChoiceManagedPath", () => {
  it("matches files under the platform config store and rejects project paths", () => {
    const env = { HOME: "/Users/tester" };
    const root = cursorPlanChoiceStoreRoot(env, "darwin", "/Users/tester");
    expect(root).toBe(
      join("/Users/tester", ".config", "deft", "runtime", "cursor-plan-choice", "v1"),
    );
    expect(
      isCursorPlanChoiceManagedPath(join(root, "abc", "def.json"), env, "darwin", "/Users/tester"),
    ).toBe(true);
    expect(
      isCursorPlanChoiceManagedPath(
        "/Users/tester/project/src/index.ts",
        env,
        "darwin",
        "/Users/tester",
      ),
    ).toBe(false);
  });
});
