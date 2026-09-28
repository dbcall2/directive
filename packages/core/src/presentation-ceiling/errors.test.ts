import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evaluatePresentationCeiling,
  parseCeilingPayload,
  resolvePresentationCeilingBaseRef,
} from "./evaluate.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  readFileSync: vi.fn(),
}));

const ROOT = "/fixture";
const CEILING = ".deft/presentation-ceiling.json";
const BASE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const payload = '{"changeClass":"presentation"}';
const gitSuccess = (stdout: string) => ({
  pid: 1,
  status: 0,
  signal: null,
  output: [null, stdout, ""],
  stdout,
  stderr: "",
});
function mockGit(failure?: (args: string[]) => object | undefined) {
  vi.mocked(childProcess.spawnSync).mockImplementation(((_command: string, args: string[]) => {
    const failed = failure?.(args);
    if (failed) return failed;
    switch (args[0]) {
      case "rev-parse":
        return gitSuccess("true\n");
      case "merge-base":
        return gitSuccess(BASE);
      case "ls-tree":
        return gitSuccess(`${CEILING}\0.deft/test-boundary.policy.json\0`);
      case "diff":
        return gitSuccess("View.tsx\0");
      case "ls-files":
        return gitSuccess("");
      case "grep":
        return gitSuccess(args.includes(BASE) ? `${BASE}:${CEILING}\0` : `${CEILING}\0`);
      case "show":
        return gitSuccess(args[1]?.endsWith("test-boundary.policy.json") ? "{}" : payload);
      default:
        return gitSuccess("");
    }
  }) as typeof childProcess.spawnSync);
  vi.mocked(fs.readFileSync).mockImplementation(((path: string) =>
    String(path).endsWith("View.tsx") ? "<div/>" : payload) as typeof fs.readFileSync);
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe("presentation collector fails closed on unavailable input", () => {
  it.each([
    [
      "missing Git",
      { error: Object.assign(new Error("missing"), { code: "ENOENT" }), status: null },
    ],
    ["spawn failure", { error: new Error("denied"), status: null }],
    ["signal", { signal: "SIGTERM", status: null }],
    ["unknown status", { status: null }],
  ])("returns configuration failure for %s", (_name, failure) => {
    mockGit(() => failure);
    expect(evaluatePresentationCeiling(ROOT, { baseRef: "main" }).exitCode).toBe(2);
  });
  it.each([
    ["merge-base"],
    ["ls-tree"],
    ["diff", "HEAD"],
    ["ls-files"],
    ["grep", BASE],
    ["grep"],
    ["show"],
  ])("does not silently skip a failed %s read", (command, discriminator) => {
    mockGit((args) =>
      args[0] === command && (discriminator === undefined || args.includes(discriminator))
        ? { ...gitSuccess(""), status: 128 }
        : undefined,
    );
    expect(evaluatePresentationCeiling(ROOT, { baseRef: "main" }).exitCode).toBe(2);
  });
  it("does not silently skip failed reader grep after successful artifact collection", () => {
    let count = 0;
    mockGit((args) =>
      args[0] === "grep" && ++count > 2 ? { ...gitSuccess(""), status: 2 } : undefined,
    );
    expect(evaluatePresentationCeiling(ROOT, { baseRef: "main" }).exitCode).toBe(2);
  });
  it("returns configuration failure for unreadable current artifacts", () => {
    mockGit();
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    expect(evaluatePresentationCeiling(ROOT, { baseRef: "main" }).exitCode).toBe(2);
  });
  it.each([
    "null",
    "[]",
    '"text"',
    '{"testRoots":42}',
    '{"fixtureRoots":[false]}',
  ])("refuses malformed baseline policy %s", (text) => {
    mockGit((args) =>
      args[0] === "show" && args[1]?.endsWith("test-boundary.policy.json")
        ? gitSuccess(text)
        : undefined,
    );
    expect(evaluatePresentationCeiling(ROOT, { baseRef: "main" }).exitCode).toBe(2);
  });
  it.each(["null", "[]", '"text"'])("refuses malformed ceiling object %s", (text) => {
    mockGit((args) => (args[0] === "show" ? gitSuccess(text) : undefined));
    expect(evaluatePresentationCeiling(ROOT, { baseRef: "main" }).exitCode).toBe(2);
  });
  it("reports no resolvable base instead of evaluating against an invented ref", () => {
    vi.stubEnv("DEFT_BASE_REF", undefined);
    vi.stubEnv("GITHUB_BASE_REF", undefined);
    mockGit((args) =>
      args[0] === "rev-parse" && args[1] === "--verify"
        ? { ...gitSuccess(""), status: 1 }
        : undefined,
    );
    expect(evaluatePresentationCeiling(ROOT).exitCode).toBe(2);
  });
  it("does not fall back when an explicitly configured ref is invalid", () => {
    vi.stubEnv("DEFT_BASE_REF", "missing");
    mockGit((args) => (args[0] === "merge-base" ? { ...gitSuccess(""), status: 128 } : undefined));
    expect(evaluatePresentationCeiling(ROOT).exitCode).toBe(2);
  });
  it("resolves the configured base and handles Git spawn failures", () => {
    vi.stubEnv("DEFT_BASE_REF", "target");
    mockGit();
    expect(resolvePresentationCeilingBaseRef(ROOT)).toBe("target");
    vi.mocked(childProcess.spawnSync).mockReturnValue({
      ...gitSuccess(""),
      error: Object.assign(new Error("missing"), { code: "ENOENT" }),
    });
    expect(resolvePresentationCeilingBaseRef(ROOT)).toBeNull();
  });
});

describe("ceiling payload authority", () => {
  it.each([
    null,
    [],
    3,
    {},
    { plan: null },
    { plan: [] },
    { plan: { metadata: {} } },
    { plan: { "x-directive/changeClass": { changeClass: "backend" } } },
  ])("rejects non-presentation payload %j", (payload) => {
    expect(parseCeilingPayload(payload, CEILING)).toBeNull();
  });
  it.each([
    "presentation",
    { changeClass: "presentation" },
  ])("accepts the supported metadata shape %j", (value) => {
    expect(
      parseCeilingPayload({ plan: { metadata: { "x-directive/changeClass": value } } }, CEILING)
        ?.changeClass,
    ).toBe("presentation");
  });
  it.each([
    null,
    [],
    {},
    { kind: "operator", actor: "david" },
    { kind: "agent", actor: "bot", mintedAt: "2026-09-28T00:00:00Z" },
  ])("does not grant an invalid amendment stamp %j", (stamp) => {
    expect(
      parseCeilingPayload(
        {
          changeClass: "presentation",
          extensionAmendment: { extensions: [".sql"], humanApproval: stamp },
        },
        CEILING,
      )?.extensionAmendment,
    ).toBeNull();
  });
  it("normalizes lists and preserves a valid human amendment", () => {
    const artifact = parseCeilingPayload(
      {
        changeClass: "presentation",
        allowedExtensions: [".HTML", "", false, "tsx"],
        extensionAmendment: {
          extensions: [".SQL"],
          humanApproval: {
            kind: "operator",
            actor: "david",
            mintedAt: "2026-09-28T00:00:00Z",
            mintedVia: "in-harness-ask",
          },
        },
      },
      CEILING,
    );
    expect(artifact?.allowedExtensions).toEqual([".html", "tsx"]);
    expect(artifact?.extensionAmendment?.extensions).toEqual([".sql"]);
  });
});
