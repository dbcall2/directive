import { describe, expect, it } from "vitest";
import { diffParity, normaliseStdout, renderReport } from "./doctor-parity.js";

describe("doctor-parity helpers", () => {
  it("normaliseStdout strips uv bootstrap lines", () => {
    expect(normaliseStdout("Using CPython 3.14\nok\n")).toBe("ok\n");
  });

  it("normaliseStdout strips the TS-only pre-cutover status line (#2022)", () => {
    expect(
      normaliseStdout(
        "Pre-cutover: none -- project is on the current vBRIEF document model.\nok\n",
      ),
    ).toBe("ok\n");
    expect(normaliseStdout("Pre-cutover: migration needed -- SPECIFICATION.md ...\nok\n")).toBe(
      "ok\n",
    );
  });

  it("diffParity detects stdout mismatch", () => {
    const diff = diffParity(
      { name: "a", exitCode: 0, stdout: "x", stderr: "" },
      { name: "a", exitCode: 0, stdout: "y", stderr: "" },
    );
    expect(diff.stdoutMismatch).toBe(true);
  });

  it("renderReport clean", () => {
    expect(renderReport({ ok: true, scenarios: [] })).toContain("CLEAN");
  });
});
