import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PACKAGE_MANAGER,
  detectPackageManager,
  ENGINE_PACKAGE,
  PACKAGE_MANAGERS,
  renderEphemeral,
  renderGlobalInstall,
  renderPackageManagerCommands,
  renderProjectInstall,
  resolvePackageManager,
  resolveProjectPackageManager,
} from "./package-manager.js";

const fixtureRoots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function packageManagerFixture(
  packageJson?: Readonly<Record<string, unknown>>,
  pnpmLockPresent = false,
): string {
  const root = mkdtempSync(join(tmpdir(), "deft-package-manager-"));
  fixtureRoots.push(root);
  if (packageJson !== undefined) {
    writeFileSync(join(root, "package.json"), `${JSON.stringify(packageJson)}\n`, "utf8");
  }
  if (pnpmLockPresent) {
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  }
  return root;
}

describe("resolution/package-manager detectPackageManager (#2197)", () => {
  it("defaults to npm with no signals", () => {
    expect(detectPackageManager()).toBe("npm");
    expect(detectPackageManager({ env: {} })).toBe(DEFAULT_PACKAGE_MANAGER);
  });

  it("honors the DEFT_PACKAGE_MANAGER env override first", () => {
    expect(detectPackageManager({ env: { DEFT_PACKAGE_MANAGER: "pnpm" } })).toBe("pnpm");
    expect(detectPackageManager({ env: { DEFT_PACKAGE_MANAGER: "npm" } })).toBe("npm");
    // Override beats every lower-precedence signal.
    expect(
      detectPackageManager({
        env: { DEFT_PACKAGE_MANAGER: "npm", npm_config_user_agent: "pnpm/9.0.0" },
        pnpmLockPresent: true,
        packageManagerField: "pnpm@9.0.0",
      }),
    ).toBe("npm");
  });

  it("reads the packageManager / corepack field before the lockfile", () => {
    expect(detectPackageManager({ packageManagerField: "pnpm@9.1.0" })).toBe("pnpm");
    expect(detectPackageManager({ packageManagerField: "npm@10.0.0" })).toBe("npm");
  });

  it("falls back to pnpm-lock.yaml presence", () => {
    expect(detectPackageManager({ pnpmLockPresent: true })).toBe("pnpm");
  });

  it("falls back to npm_config_user_agent", () => {
    expect(
      detectPackageManager({ env: { npm_config_user_agent: "pnpm/9.0.0 npm/? node/v20" } }),
    ).toBe("pnpm");
    expect(detectPackageManager({ env: { npm_config_user_agent: "npm/10.0.0 node/v20" } })).toBe(
      "npm",
    );
  });

  it("ignores blank / unrecognized override values", () => {
    expect(detectPackageManager({ env: { DEFT_PACKAGE_MANAGER: "   " } })).toBe("npm");
    expect(detectPackageManager({ env: { DEFT_PACKAGE_MANAGER: "yarn" } })).toBe("npm");
  });
});

describe("resolution/package-manager strict project resolution (#3610)", () => {
  it("reports the winning manager and precedence source", () => {
    expect(
      resolvePackageManager({
        env: { DEFT_PACKAGE_MANAGER: "npm", npm_config_user_agent: "pnpm/11.8.0" },
        packageManagerField: "pnpm@11.8.0",
        pnpmLockPresent: true,
      }),
    ).toEqual({ ok: true, packageManager: "npm", source: "env-override" });
  });

  it("rejects unsupported explicit managers instead of falling through", () => {
    const result = resolvePackageManager({
      packageManagerField: "yarn@4.9.2",
      pnpmLockPresent: true,
    });
    expect(result).toMatchObject({ ok: false, source: "package-manager-field" });
    expect(result.message).toMatch(/unsupported.*yarn.*npm.*pnpm/i);
  });

  it("does not echo raw environment override text in diagnostics", () => {
    const rawOverride = "yarn; echo should-not-appear";
    const result = resolvePackageManager({
      env: { DEFT_PACKAGE_MANAGER: rawOverride },
    });
    expect(result).toMatchObject({ ok: false, source: "env-override" });
    expect(result.message).not.toContain(rawOverride);
  });

  it("rejects instruction-shaped packageManager values", () => {
    const result = resolvePackageManager({
      packageManagerField: "pnpm@11.8.0; touch should-not-run",
    });
    expect(result).toMatchObject({ ok: false, source: "package-manager-field" });
  });

  it("reads an npm declaration before a conflicting pnpm lockfile", () => {
    const root = packageManagerFixture({ packageManager: "npm@11.16.0" }, true);
    expect(resolveProjectPackageManager({ projectRoot: root, env: {} })).toEqual({
      ok: true,
      packageManager: "npm",
      source: "package-manager-field",
    });
  });

  it.each([
    "",
    "   ",
    null,
  ])("rejects an explicit malformed packageManager value %j before lockfile fallback", (packageManager) => {
    const root = packageManagerFixture({ packageManager }, true);
    const result = resolveProjectPackageManager({ projectRoot: root, env: {} });
    expect(result).toMatchObject({ ok: false, source: "package-manager-field" });
    expect(result.message).toMatch(/non-empty string.*npm.*pnpm/i);
  });

  it("stops at an environment override before reading lower-priority project files", () => {
    const result = resolveProjectPackageManager({
      projectRoot: "/consumer",
      env: { DEFT_PACKAGE_MANAGER: "npm" },
      readText: () => {
        throw new Error("package.json should not be read");
      },
      isFile: () => {
        throw new Error("lockfile should not be inspected");
      },
    });
    expect(result).toEqual({
      ok: true,
      packageManager: "npm",
      source: "env-override",
    });
  });

  it("stops at packageManager before inspecting a lower-priority lockfile", () => {
    const result = resolveProjectPackageManager({
      projectRoot: "/consumer",
      env: {},
      readText: () => JSON.stringify({ packageManager: "pnpm@11.8.0" }),
      isFile: () => {
        throw new Error("lockfile should not be inspected");
      },
    });
    expect(result).toEqual({
      ok: true,
      packageManager: "pnpm",
      source: "package-manager-field",
    });
  });

  it("uses the pnpm lockfile and then the npm default when no declaration exists", () => {
    const pnpmRoot = packageManagerFixture({}, true);
    const npmRoot = packageManagerFixture({});
    expect(resolveProjectPackageManager({ projectRoot: pnpmRoot, env: {} })).toEqual({
      ok: true,
      packageManager: "pnpm",
      source: "pnpm-lock",
    });
    expect(resolveProjectPackageManager({ projectRoot: npmRoot, env: {} })).toEqual({
      ok: true,
      packageManager: "npm",
      source: "default",
    });
  });

  it("inherits the process environment when no environment seam is supplied", () => {
    vi.stubEnv("DEFT_PACKAGE_MANAGER", "pnpm");
    const root = packageManagerFixture({});
    expect(resolveProjectPackageManager({ projectRoot: root })).toEqual({
      ok: true,
      packageManager: "pnpm",
      source: "env-override",
    });
  });

  it("fails clearly when package.json is malformed", () => {
    const root = packageManagerFixture();
    writeFileSync(join(root, "package.json"), "{not-json\n", "utf8");
    const result = resolveProjectPackageManager({ projectRoot: root, env: {} });
    expect(result).toMatchObject({ ok: false, source: "package-json" });
    expect(result.message).toMatch(/parse.*package\.json/i);
  });

  it("fails clearly when the project lockfile cannot be inspected", () => {
    const result = resolveProjectPackageManager({
      projectRoot: "/consumer",
      env: {},
      readText: () => null,
      isFile: () => {
        throw new Error("permission denied");
      },
    });
    expect(result).toMatchObject({ ok: false, source: "project-filesystem" });
    expect(result.message).toMatch(/inspect.*pnpm-lock\.yaml.*permission denied/i);
  });
});

describe("resolution/package-manager renderers (#2197)", () => {
  it("renders npm global install", () => {
    expect(renderGlobalInstall("npm")).toBe(`npm i -g ${ENGINE_PACKAGE}`);
    expect(renderGlobalInstall("npm", `${ENGINE_PACKAGE}@0.65.0`)).toBe(
      "npm i -g @deftai/directive@0.65.0",
    );
  });

  it("renders pnpm global install", () => {
    expect(renderGlobalInstall("pnpm")).toBe(`pnpm add -g ${ENGINE_PACKAGE}`);
    expect(renderGlobalInstall("pnpm", `${ENGINE_PACKAGE}@0.65.0`)).toBe(
      "pnpm add -g @deftai/directive@0.65.0",
    );
  });

  it("renders project-local install per manager", () => {
    expect(renderProjectInstall("npm")).toBe(`npm install --save-dev ${ENGINE_PACKAGE}`);
    expect(renderProjectInstall("pnpm")).toBe(`pnpm add -D ${ENGINE_PACKAGE}`);
  });

  it("renders ephemeral invocations per manager", () => {
    expect(renderEphemeral("npm", "update")).toBe(`npx ${ENGINE_PACKAGE} update`);
    expect(renderEphemeral("pnpm", "update")).toBe(`pnpm dlx ${ENGINE_PACKAGE} update`);
    expect(renderEphemeral("npm", "")).toBe(`npx ${ENGINE_PACKAGE}`);
  });

  it("renders the full command matrix", () => {
    for (const pm of PACKAGE_MANAGERS) {
      const cmds = renderPackageManagerCommands(pm);
      expect(cmds.packageManager).toBe(pm);
      expect(cmds.upgradeOneLiner).toContain(`${ENGINE_PACKAGE}@latest`);
      expect(cmds.globalInstall).toContain(ENGINE_PACKAGE);
      expect(cmds.projectInstall).toContain(ENGINE_PACKAGE);
      expect(cmds.ephemeralUpdate).toContain("update");
    }
    expect(renderPackageManagerCommands("pnpm").upgradeOneLiner).toBe(
      "pnpm add -g @deftai/directive@latest",
    );
    expect(renderPackageManagerCommands("npm").upgradeOneLiner).toBe(
      "npm i -g @deftai/directive@latest",
    );
  });

  it("never emits a custom --registry flag (locked decision: same npm registry)", () => {
    for (const pm of PACKAGE_MANAGERS) {
      const cmds = renderPackageManagerCommands(pm);
      for (const cmd of [
        cmds.globalInstall,
        cmds.projectInstall,
        cmds.ephemeralUpdate,
        cmds.upgradeOneLiner,
      ]) {
        expect(cmd).not.toContain("--registry");
        expect(cmd).not.toContain("registry=");
      }
    }
  });
});
