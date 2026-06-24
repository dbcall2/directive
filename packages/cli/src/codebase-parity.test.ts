import { describe, expect, it } from "vitest";
import { diffCase, normalizeOutput, PARITY_CASES } from "./codebase-parity.js";

describe("codebase-parity helpers", () => {
  it("detects stdout mismatch", () => {
    const diff = diffCase(
      { exitCode: 0, stdout: "a", stderr: "" },
      { exitCode: 0, stdout: "b", stderr: "" },
      "x",
    );
    expect(diff.stdoutMismatch).toBe(true);
  });

  it("normalizes volatile codebase fixture roots", () => {
    const raw =
      '{"project_root": "/private/var/folders/0z/example/T/deft-codebase-parity-abc123"}\n' +
      '{"project_root": "/tmp/deft-codebase-parity-def456"}\n';

    expect(normalizeOutput(raw)).toBe(
      '{"project_root": "<TMP>"}\n' + '{"project_root": "<TMP>"}\n',
    );
  });

  it("defines parity cases", () => {
    expect(PARITY_CASES.length).toBeGreaterThan(0);
  });
});
