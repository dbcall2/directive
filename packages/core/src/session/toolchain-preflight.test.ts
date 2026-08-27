import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PACKAGE_MANAGER_DEPENDENT_GATE_IDS,
  runToolchainPreflight,
  SKIP_ALL_GATES,
  toolchainPreflightToDict,
} from "./toolchain-preflight.js";

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function consumerFixture(packageManager: string): string {
  const root = mkdtempSync(join(tmpdir(), "deft-preflight-consumer-"));
  fixtureRoots.push(root);
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ packageManager })}\n`, "utf8");
  return root;
}

describe("runToolchainPreflight (#3282)", () => {
  it("reports ok when task, pnpm, node, and git are present", () => {
    const result = runToolchainPreflight({
      which: (name) => `/bin/${name}`,
      exists: () => true,
      probeCliDist: false,
    });
    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.status).toBe("ok");
    expect(result.skipGateIds).toEqual([]);
    expect(result.lines.some((l) => l.includes("done-gate toolchain ready"))).toBe(true);
  });

  it("surfaces missing go-task with cause and remedy in one turn", () => {
    const result = runToolchainPreflight({
      which: (name) => (name === "task" ? null : `/bin/${name}`),
      exists: () => false,
      probeCliDist: false,
    });
    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.status).toBe("degraded");
    const task = result.findings.find((f) => f.tool === "task");
    expect(task?.present).toBe(false);
    expect(task?.cause).toMatch(/go-task|PATH/i);
    expect(task?.remedy).toMatch(/taskfile\.dev|go-task/i);
    expect(result.lines.some((l) => l.includes("task: MISSING"))).toBe(true);
    expect(result.lines.some((l) => l.includes("cause:"))).toBe(true);
    expect(result.lines.some((l) => l.includes("remedy:"))).toBe(true);
    // Does not embed env values
    expect(result.lines.join("\n")).not.toMatch(/DEFT_[A-Z]+=/);
    expect(result.skipGateIds).toContain(SKIP_ALL_GATES);
  });

  it("marks only package-manager-dependent gates when maintainer pnpm is missing", () => {
    const result = runToolchainPreflight({
      which: (name) => (name === "pnpm" ? null : `/bin/${name}`),
      probeCliDist: false,
    });
    expect(result.degraded).toBe(true);
    for (const id of PACKAGE_MANAGER_DEPENDENT_GATE_IDS) {
      expect(result.skipGateIds).toContain(id);
    }
    expect(result.skipGateIds).not.toContain("verify:branch");
  });

  it("selects npm for an npm-pinned consumer and never probes pnpm", () => {
    const projectRoot = consumerFixture("npm@11.16.0");
    const probed: string[] = [];
    const result = runToolchainPreflight({
      projectRoot,
      consumerDeposit: true,
      which: (name) => {
        probed.push(name);
        return name === "task" || name === "pnpm" ? null : `/bin/${name}`;
      },
      exists: () => false,
      probeCliDist: true,
      env: {},
    });
    expect(result.ok).toBe(true);
    expect(result.packageManager).toBe("npm");
    expect(result.packageManagerSource).toBe("package-manager-field");
    expect(probed).toContain("npm");
    expect(probed).not.toContain("pnpm");
    expect(result.lines.join("\n")).toMatch(/package manager: npm.*packageManager field/i);
    expect(result.lines.join("\n")).not.toMatch(/Install go-task|taskfile\.dev/i);
  });

  it("treats the production same-root session:start shape as a consumer deposit", () => {
    const projectRoot = consumerFixture("npm@11.16.0");
    const probed: string[] = [];
    const result = runToolchainPreflight({
      projectRoot,
      frameworkRoot: projectRoot,
      which: (name) => {
        probed.push(name);
        return `/bin/${name}`;
      },
      probeCliDist: false,
      env: {},
    });
    expect(result.packageManager).toBe("npm");
    expect(result.packageManagerSource).toBe("package-manager-field");
    expect(probed).toContain("npm");
    expect(probed).not.toContain("pnpm");
  });

  it("selects pnpm for a pnpm-pinned consumer and never probes npm", () => {
    const projectRoot = consumerFixture("pnpm@11.8.0");
    const probed: string[] = [];
    const result = runToolchainPreflight({
      projectRoot,
      consumerDeposit: true,
      which: (name) => {
        probed.push(name);
        return name === "npm" ? null : `/bin/${name}`;
      },
      probeCliDist: false,
      env: {},
    });
    expect(result.ok).toBe(true);
    expect(result.packageManager).toBe("pnpm");
    expect(probed).toContain("pnpm");
    expect(probed).not.toContain("npm");
  });

  it("uses npm-specific cause and remedy when declared npm is missing", () => {
    const projectRoot = consumerFixture("npm@11.16.0");
    const result = runToolchainPreflight({
      projectRoot,
      consumerDeposit: true,
      which: (name) => (name === "npm" ? null : `/bin/${name}`),
      probeCliDist: false,
      env: {},
    });
    expect(result.degraded).toBe(true);
    const npm = result.findings.find((finding) => finding.tool === "npm");
    expect(npm?.cause).toMatch(/npm binary not found/i);
    expect(npm?.remedy).toMatch(/npm|Node/i);
    expect(npm?.remedy).not.toMatch(/pnpm|corepack/i);
    expect(result.skipGateIds).toEqual([...PACKAGE_MANAGER_DEPENDENT_GATE_IDS].sort());
  });

  it("uses npm-specific Node remediation for an npm-pinned consumer", () => {
    const projectRoot = consumerFixture("npm@11.16.0");
    const result = runToolchainPreflight({
      projectRoot,
      consumerDeposit: true,
      which: (name) => (name === "node" ? null : `/bin/${name}`),
      probeCliDist: false,
      env: {},
    });
    const node = result.findings.find((finding) => finding.tool === "node");
    expect(node?.remedy).toMatch(/npm is bundled/i);
    expect(node?.remedy).not.toMatch(/pnpm|corepack/i);
  });

  it("fails clearly on an unsupported declared manager without probing its raw value", () => {
    const projectRoot = consumerFixture("yarn@4.9.2; touch should-not-run");
    const probed: string[] = [];
    const result = runToolchainPreflight({
      projectRoot,
      consumerDeposit: true,
      which: (name) => {
        probed.push(name);
        return `/bin/${name}`;
      },
      probeCliDist: false,
      env: {},
    });
    expect(result.degraded).toBe(true);
    expect(result.packageManager).toBeNull();
    expect(result.findings.find((finding) => finding.tool === "package_manager")?.cause).toMatch(
      /unsupported package manager/i,
    );
    expect(probed.join(" ")).not.toContain("should-not-run");
    expect(result.skipGateIds).toEqual([...PACKAGE_MANAGER_DEPENDENT_GATE_IDS].sort());
  });

  it("serializes without env values", () => {
    const result = runToolchainPreflight({
      which: () => null,
      probeCliDist: false,
    });
    const dict = toolchainPreflightToDict(result);
    expect(dict.status).toBe("degraded");
    expect(JSON.stringify(dict)).not.toMatch(/DEFT_[A-Z]+=/);
    expect(result.skipGateIds).toContain(SKIP_ALL_GATES);
  });

  it("treats missing go-task as impact none in a CLI-dispatchable deposit (#3335)", () => {
    const projectRoot = consumerFixture("npm@11.16.0");
    const result = runToolchainPreflight({
      projectRoot,
      which: (name) => (name === "task" ? null : `/bin/${name}`),
      exists: () => false,
      probeCliDist: true,
      consumerDeposit: true,
      env: {},
    });
    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.status).toBe("ok");
    expect(result.skipGateIds).toEqual([]);
    const task = result.findings.find((f) => f.tool === "task");
    expect(task?.present).toBe(false);
    expect(task?.impact).toBe("none");
    expect(task?.remedy).toBeNull();
    expect(result.lines.join("\n")).not.toMatch(/Install go-task|taskfile\.dev/i);
    expect(result.lines.some((l) => l.includes("impact: none"))).toBe(true);
    expect(result.lines.some((l) => l.includes("go-task not required"))).toBe(true);
  });

  it("does not recommend installing go-task when the deposit has no CLI either (#3335)", () => {
    const projectRoot = consumerFixture("npm@11.16.0");
    const result = runToolchainPreflight({
      projectRoot,
      which: (name) =>
        name === "task" || name === "deft" || name === "directive" ? null : `/bin/${name}`,
      exists: () => false,
      probeCliDist: true,
      consumerDeposit: true,
      env: {},
    });
    expect(result.degraded).toBe(true);
    expect(result.skipGateIds).toContain(SKIP_ALL_GATES);
    const task = result.findings.find((f) => f.tool === "task");
    expect(task?.remedy).toMatch(/@deftai\/directive/);
    expect(task?.remedy).not.toMatch(/go-task|taskfile\.dev/i);
    expect(result.lines.join("\n")).not.toMatch(/Install go-task|taskfile\.dev/i);
  });

  it("marks advisory missing Git separately from the CLI artifact that degrades checks", () => {
    const projectRoot = consumerFixture("npm@11.16.0");
    const result = runToolchainPreflight({
      projectRoot,
      frameworkRoot: projectRoot,
      which: (name) =>
        name === "task" || name === "git" || name === "deft" || name === "directive"
          ? null
          : `/bin/${name}`,
      exists: () => false,
      probeCliDist: true,
      env: {},
    });
    expect(result.degraded).toBe(true);
    expect(result.findings.find((finding) => finding.tool === "git")?.impact).toBe("none");
    expect(result.findings.find((finding) => finding.tool === "cli_dist")?.impact).toBe("degraded");
    expect(result.lines.join("\n")).toMatch(/git: absent.*remedy: Install Git/i);
  });

  it("probes CLI dist when no global deft and dist missing", () => {
    const result = runToolchainPreflight({
      frameworkRoot: "/tmp/fw-no-dist",
      which: (name) => (name === "deft" || name === "directive" ? null : `/bin/${name}`),
      exists: () => false,
      probeCliDist: true,
    });
    const cli = result.findings.find((f) => f.tool === "cli_dist");
    expect(cli?.present).toBe(false);
    expect(cli?.remedy).toMatch(/task build|@deftai\/directive/);
  });
});
