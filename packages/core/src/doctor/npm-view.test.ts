import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { defaultNpmViewVersion } from "./npm-view.js";

describe("defaultNpmViewVersion (#2808)", () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
  });

  it("pins payload release lookup to the canonical public registry", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "0.84.0\n",
      stderr: "",
      pid: 1,
      output: [null, "0.84.0\n", ""],
      signal: null,
      error: undefined,
    });

    expect(defaultNpmViewVersion()).toEqual({ ok: true, version: "0.84.0" });
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      "npm",
      [
        "view",
        "@deftai/directive",
        "version",
        "--registry=https://registry.npmjs.org/",
        "--ignore-scripts",
      ],
      {
        encoding: "utf8",
        shell: false,
        timeout: 15_000,
        windowsHide: true,
      },
    );
  });

  it("returns unavailable when the public registry lookup fails", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: "0.84.0\n",
      stderr: "network unavailable",
      pid: 1,
      output: [null, "0.84.0\n", "network unavailable"],
      signal: null,
      error: undefined,
    });

    expect(defaultNpmViewVersion()).toEqual({ ok: false, version: "" });
  });
});
