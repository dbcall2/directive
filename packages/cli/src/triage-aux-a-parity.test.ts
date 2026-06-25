import { describe, expect, it } from "vitest";
import { diffCase, normalizeOutput, PARITY_CASES, renderReport } from "./triage-aux-a-parity.js";

describe("triage-aux-a parity helpers", () => {
  it("normalizeOutput strips volatile project roots and uv bootstrap noise", () => {
    const raw =
      "WARN Server returned unusable 304 for: https://example.test\n" +
      "Using CPython 3.13.0\n" +
      "Creating virtual environment at: .venv\n" +
      "Installed 4 packages in 10ms\n" +
      "triage:welcome: --project-root /private/var/folders/0z/example/T/deft-triage-missing-dir is not a directory.\n" +
      'payload {"project_root": "/tmp/deft-abc"} project_root=/tmp/deft-xyz\n';

    expect(normalizeOutput(raw)).toBe(
      "triage:welcome: --project-root <TMP> is not a directory.\n" +
        'payload {"project_root": "<ROOT>"} project_root=<ROOT>\n',
    );
  });

  it("diffCase reports parity after normalization", () => {
    const diff = diffCase(
      { exitCode: 0, stdout: "project_root=/tmp/a\n", stderr: "" },
      { exitCode: 0, stdout: "project_root=/tmp/b\n", stderr: "" },
      "normalized",
    );

    expect(diff.exitMismatch).toBe(false);
    expect(diff.stdoutMismatch).toBe(false);
    expect(diff.stderrMismatch).toBe(false);
  });

  it("renderReport includes divergence details", () => {
    const report = renderReport({
      ok: false,
      diffs: [
        {
          caseName: "welcome-default-empty",
          exitMismatch: true,
          stdoutMismatch: false,
          stderrMismatch: true,
          pythonExit: 1,
          tsExit: 0,
        },
      ],
    });

    expect(report).toContain("DIVERGENCE");
    expect(report).toContain("welcome-default-empty");
    expect(report).toContain("stderr mismatch");
  });

  it("keeps aux-A case coverage", () => {
    expect(PARITY_CASES.map((testCase) => testCase.name)).toContain("welcome-default-empty");
  });
});
