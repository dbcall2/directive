import { describe, expect, it } from "vitest";
import { normalizeMessage } from "./render-parity.js";

describe("render parity helpers", () => {
  it("normalizeMessage strips volatile render fixture roots", () => {
    const raw =
      "rendered to /private/var/folders/0z/example/T/deft-render-parity-py-abc123/SPECIFICATION.md\n" +
      "rendered to /tmp/deft-render-parity-ts-def456/ROADMAP.md\n";

    expect(normalizeMessage(raw)).toBe(
      "rendered to <TMP>/SPECIFICATION.md\nrendered to <TMP>/ROADMAP.md\n",
    );
  });
});
