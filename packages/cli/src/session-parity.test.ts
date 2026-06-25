import { describe, expect, it } from "vitest";
import { PARITY_CASES, renderReport } from "./session-parity.js";

// Hermetic unit tests: live Python-vs-TS parity shells out through `uv run
// python` and belongs to the dedicated `task ts:parity-all` lane. Keeping
// Vitest on pure helpers avoids host/runner contention in the broad TS suite.
describe("session parity helpers", () => {
  it("renders CLEAN with the configured case count", () => {
    const result = {
      ok: true,
      diffs: PARITY_CASES.map((c) => ({
        name: c.name,
        exitMismatch: false,
        stdoutMismatch: false,
        pythonExit: 0,
        tsExit: 0,
        pythonStdout: "",
        tsStdout: "",
      })),
    };
    expect(renderReport(result)).toContain(
      `CLEAN -- Python and TS agree on ${PARITY_CASES.length}`,
    );
  });

  it("renders divergence details", () => {
    const report = renderReport({
      ok: false,
      diffs: [
        {
          name: "quick-tier",
          exitMismatch: true,
          stdoutMismatch: true,
          pythonExit: 1,
          tsExit: 0,
          pythonStdout: '{"ready":false}\n',
          tsStdout: '{"ready":true}\n',
        },
      ],
    });
    expect(report).toContain("DIVERGENCE");
    expect(report).toContain("quick-tier");
    expect(report).toContain("python stdout");
  });
});
