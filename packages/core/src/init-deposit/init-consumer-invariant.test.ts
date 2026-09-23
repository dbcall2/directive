import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PIN_DEPENDENCY_NAME, readPin } from "../resolution/pin.js";
import {
  formatInitConsumerInvariantRefuseMessage,
  INIT_CONSUMER_INVARIANT_REFUSE_MESSAGE,
  inspectInitConsumerInvariant,
  reassertInitConsumerInvariant,
  restoreNullPinAtRecordedDepositVersion,
} from "./init-consumer-invariant.js";

const created: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function freshRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  created.push(root);
  return root;
}

describe("formatInitConsumerInvariantRefuseMessage (#4533)", () => {
  it("names only the remaining gaps", () => {
    expect(
      formatInitConsumerInvariantRefuseMessage({
        pinMissing: true,
        agentsMissing: false,
        gitignoreMissing: false,
      }),
    ).toContain("@deftai/directive pin");
    expect(
      formatInitConsumerInvariantRefuseMessage({
        pinMissing: true,
        agentsMissing: false,
        gitignoreMissing: false,
      }),
    ).not.toContain("AGENTS.md");
    expect(
      formatInitConsumerInvariantRefuseMessage({
        pinMissing: true,
        agentsMissing: true,
        gitignoreMissing: true,
      }),
    ).toMatch(/pin.*AGENTS\.md managed section.*\.gitignore/);
    expect(INIT_CONSUMER_INVARIANT_REFUSE_MESSAGE).toContain(".gitignore");
    expect(INIT_CONSUMER_INVARIANT_REFUSE_MESSAGE).toContain("@deftai/directive pin");
  });
});

describe("inspectInitConsumerInvariant (#4533)", () => {
  it("reports pin, agents, and gitignore gaps independently", () => {
    const project = freshRoot("invariant-inspect-");
    expect(inspectInitConsumerInvariant(project)).toEqual({
      pinMissing: true,
      agentsMissing: true,
      gitignoreMissing: true,
    });
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ private: true, devDependencies: { [PIN_DEPENDENCY_NAME]: "0.54.0" } }),
      "utf8",
    );
    writeFileSync(
      join(project, "AGENTS.md"),
      "<!-- deft:managed-section v3 -->\nbody\n<!-- /deft:managed-section -->\n",
      "utf8",
    );
    writeFileSync(join(project, ".gitignore"), ".deft-cache/\n", "utf8");
    expect(inspectInitConsumerInvariant(project)).toEqual({
      pinMissing: false,
      agentsMissing: false,
      gitignoreMissing: false,
    });
  });
});

describe("reassertInitConsumerInvariant (#4533)", () => {
  it("calls each missing writer once and then holds", () => {
    const project = freshRoot("invariant-reassert-");
    const deftDir = join(project, ".deft", "core");
    mkdirSync(deftDir, { recursive: true });
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "app" }), "utf8");
    writeFileSync(join(project, "AGENTS.md"), "# App\n", "utf8");
    writeFileSync(join(project, ".gitignore"), "node_modules\n", "utf8");

    const pin = vi.fn(() => {
      writeFileSync(
        join(project, "package.json"),
        JSON.stringify({
          name: "app",
          private: true,
          devDependencies: { [PIN_DEPENDENCY_NAME]: "0.54.0" },
        }),
        "utf8",
      );
      return { changed: true, pinVersion: "0.54.0", created: false };
    });
    const agents = vi.fn(() => {
      writeFileSync(
        join(project, "AGENTS.md"),
        "<!-- deft:managed-section v3 -->\nbody\n<!-- /deft:managed-section -->\n",
        "utf8",
      );
      return true;
    });
    const gitignore = vi.fn(() => {
      writeFileSync(join(project, ".gitignore"), ".deft-cache/\n", "utf8");
      return { changed: true, deftCoreIgnored: false, skippedDeftCoreBecauseTracked: false };
    });

    const result = reassertInitConsumerInvariant({
      projectDir: project,
      deftDir,
      pinVersion: "0.54.0",
      io: { printf: () => undefined },
      writers: {
        ensurePackageJsonPin: pin,
        writeAgentsMd: agents,
        ensureInitGitignoreLines: gitignore,
      },
    });

    expect(pin).toHaveBeenCalledTimes(1);
    expect(agents).toHaveBeenCalledTimes(1);
    expect(gitignore).toHaveBeenCalledTimes(1);
    expect(result.refuseMessage).toBeNull();
    expect(result.gap).toEqual({
      pinMissing: false,
      agentsMissing: false,
      gitignoreMissing: false,
    });
  });

  it("refuses after one re-assert when writers leave the gap", () => {
    const project = freshRoot("invariant-refuse-");
    const deftDir = join(project, ".deft", "core");
    mkdirSync(deftDir, { recursive: true });
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "app" }), "utf8");
    writeFileSync(join(project, "AGENTS.md"), "# App\n", "utf8");

    const pin = vi.fn(() => ({ changed: false, pinVersion: "0.54.0", created: false }));
    const agents = vi.fn(() => false);
    const gitignore = vi.fn(() => ({
      changed: false,
      deftCoreIgnored: false,
      skippedDeftCoreBecauseTracked: false,
    }));

    const result = reassertInitConsumerInvariant({
      projectDir: project,
      deftDir,
      pinVersion: "0.54.0",
      io: { printf: () => undefined },
      writers: {
        ensurePackageJsonPin: pin,
        writeAgentsMd: agents,
        ensureInitGitignoreLines: gitignore,
      },
    });

    expect(pin).toHaveBeenCalledTimes(1);
    expect(agents).toHaveBeenCalledTimes(1);
    expect(gitignore).toHaveBeenCalledTimes(1);
    expect(result.gap).toEqual({
      pinMissing: true,
      agentsMissing: true,
      gitignoreMissing: true,
    });
    expect(result.refuseMessage).toBe(formatInitConsumerInvariantRefuseMessage(result.gap));
    expect(result.refuseMessage).toContain("@deftai/directive pin");
    expect(result.refuseMessage).toContain("AGENTS.md managed section");
    expect(result.refuseMessage).toContain(".gitignore");
    expect(result.refuseMessage).toContain("directive init");
    expect(result.refuseMessage).toContain("directive update");
  });

  it("names only .gitignore when that is the remaining gap", () => {
    const project = freshRoot("invariant-gitignore-only-");
    const deftDir = join(project, ".deft", "core");
    mkdirSync(deftDir, { recursive: true });
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ private: true, devDependencies: { [PIN_DEPENDENCY_NAME]: "0.54.0" } }),
      "utf8",
    );
    writeFileSync(
      join(project, "AGENTS.md"),
      "<!-- deft:managed-section v3 -->\nbody\n<!-- /deft:managed-section -->\n",
      "utf8",
    );

    const result = reassertInitConsumerInvariant({
      projectDir: project,
      deftDir,
      pinVersion: "0.54.0",
      io: { printf: () => undefined },
      writers: {
        ensureInitGitignoreLines: () => ({
          changed: false,
          deftCoreIgnored: false,
          skippedDeftCoreBecauseTracked: false,
        }),
      },
    });

    expect(result.gap).toEqual({
      pinMissing: false,
      agentsMissing: false,
      gitignoreMissing: true,
    });
    expect(result.refuseMessage).toBe(
      formatInitConsumerInvariantRefuseMessage({
        pinMissing: false,
        agentsMissing: false,
        gitignoreMissing: true,
      }),
    );
    expect(result.refuseMessage).toContain(".gitignore");
    expect(result.refuseMessage).not.toContain("@deftai/directive pin");
    expect(result.refuseMessage).not.toContain("AGENTS.md");
  });

  it("does not call writers when the invariant already holds", () => {
    const project = freshRoot("invariant-hold-");
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ private: true, devDependencies: { [PIN_DEPENDENCY_NAME]: "0.54.0" } }),
      "utf8",
    );
    writeFileSync(
      join(project, "AGENTS.md"),
      "<!-- deft:managed-section v3 -->\nbody\n<!-- /deft:managed-section -->\n",
      "utf8",
    );
    writeFileSync(join(project, ".gitignore"), ".deft-cache/\n", "utf8");
    const pin = vi.fn();
    const result = reassertInitConsumerInvariant({
      projectDir: project,
      deftDir: join(project, ".deft", "core"),
      pinVersion: "0.54.0",
      io: { printf: () => undefined },
      writers: { ensurePackageJsonPin: pin },
    });
    expect(pin).not.toHaveBeenCalled();
    expect(result.refuseMessage).toBeNull();
  });
});

describe("restoreNullPinAtRecordedDepositVersion (#4533)", () => {
  it("writes ensurePackageJsonPin at the recorded deposit version when the pin is absent", () => {
    const project = freshRoot("null-pin-restore-");
    const deftDir = join(project, ".deft", "core");
    mkdirSync(deftDir, { recursive: true });
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "app" }), "utf8");
    const wrote = restoreNullPinAtRecordedDepositVersion({
      projectDir: project,
      deftDir,
      recordedVersion: "0.54.0",
      io: { printf: () => undefined },
    });
    expect(wrote).toBe(true);
    expect(readPin(project).pinVersion).toBe("0.54.0");
  });

  it("no-ops when the deposit directory is absent", () => {
    const project = freshRoot("null-pin-no-deposit-");
    const wrote = restoreNullPinAtRecordedDepositVersion({
      projectDir: project,
      deftDir: join(project, ".deft", "core"),
      recordedVersion: "0.54.0",
      io: { printf: () => undefined },
    });
    expect(wrote).toBe(false);
    expect(readPin(project).pinVersion).toBeNull();
  });
});
