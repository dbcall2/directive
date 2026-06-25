import { describe, expect, it } from "vitest";
import { normaliseStderr } from "./release-parity.js";

describe("release parity helpers", () => {
  it("normaliseStderr strips volatile dates and release fixture paths", () => {
    const raw =
      "[6/13] CHANGELOG promotion... ## [0.21.0] - 2026-06-24\n" +
      "would run in /private/var/folders/0z/example/T/deft-release-parity-abc123)\n" +
      "would run in /tmp/deft-release-parity-def456)\n";

    expect(normaliseStderr(raw)).toBe(
      "[6/13] CHANGELOG promotion... ## [0.21.0] - YYYY-MM-DD\n" +
        "would run in <TMP>)\n" +
        "would run in <TMP>)\n",
    );
  });
});
