import { describe, expect, it } from "vitest";
import { normalizeOutput } from "./vbrief-reconcile-parity.js";

describe("vbrief reconcile parity helpers", () => {
  it("normalizeOutput strips volatile reconcile fixture roots", () => {
    const raw =
      "Error: no vbrief/proposed/ directory found under " +
      "/private/var/folders/0z/example/T/deft-vbrief-reconcile-graph-abc123\n" +
      "Error: no vbrief/proposed/ directory found under /tmp/deft-vbrief-reconcile-py-def456\n";

    expect(normalizeOutput(raw)).toBe(
      "Error: no vbrief/proposed/ directory found under <TMP>\n" +
        "Error: no vbrief/proposed/ directory found under <TMP>\n",
    );
  });
});
