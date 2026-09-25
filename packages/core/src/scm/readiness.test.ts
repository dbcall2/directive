import { afterEach, describe, expect, it, vi } from "vitest";
import {
  probeRuntimeCapabilities,
  type RuntimeCapabilityReport,
} from "../intake/platform-capabilities.js";
import type { ManagedRuntimeProbe } from "../platform/cursor-managed-runtime.js";
import {
  ENV_WORKER_CREDENTIAL_DELIVERY_ID,
  type ReadWorkerAuthAssignmentResult,
  type WorkerAuthAssignment,
} from "../swarm/worker-auth-assignment.js";
import type { CompletedProcess } from "./call.js";
import { ScmStubError } from "./errors.js";
import {
  assertScmBinaryPresent,
  clearScmReadyCache,
  formatScmReadinessLines,
  probeScmReadiness,
  requireScmReady,
  SCM_DEPENDENT_GATES,
  scmNotReadyError,
  scmReadinessToDict,
} from "./readiness.js";

function okProc(stdout = ""): CompletedProcess {
  return { args: [], returncode: 0, stdout, stderr: "" };
}
function failProc(stderr = "auth failed"): CompletedProcess {
  return { args: [], returncode: 1, stdout: "", stderr };
}

describe("probeScmReadiness (#2275)", () => {
  it("reports binary-absent when neither ghx nor gh is on PATH", () => {
    const report = probeScmReadiness({
      whichFn: () => null,
      env: {},
      checkAuthStatus: false,
      githubAuthMode: "host-gh",
      runtimeReport: { runtimeMode: "local-unsandboxed" },
    });
    expect(report.ready).toBe(false);
    expect(report.authState).toBe("binary-absent");
    expect(report.binary).toBeNull();
    expect(report.failureKind).toBe("binary_absent");
    expect(report.skippedGates).toEqual([...SCM_DEPENDENT_GATES]);
    expect(report.detail).toMatch(/gh not found on PATH/);
    expect(report.detail).toMatch(/SCM-dependent gates skipped/);
    expect(report.remediation).toMatch(/execution env/);
  });

  it("prefers ghx over gh in the binary ladder", () => {
    const report = probeScmReadiness({
      whichFn: (name) => (name === "ghx" || name === "gh" ? `/bin/${name}` : null),
      env: {},
      checkAuthStatus: false,
      githubAuthMode: "host-gh",
      runtimeReport: { runtimeMode: "local-unsandboxed" },
    });
    expect(report.ready).toBe(true);
    expect(report.binary).toBe("ghx");
    expect(report.binaryPath).toBe("/bin/ghx");
  });

  it("falls back to gh when ghx is absent", () => {
    const report = probeScmReadiness({
      whichFn: (name) => (name === "gh" ? "/usr/bin/gh" : null),
      env: {},
      checkAuthStatus: false,
      githubAuthMode: "host-gh",
      runtimeReport: { runtimeMode: "local-unsandboxed" },
    });
    expect(report.binary).toBe("gh");
    expect(report.ready).toBe(true);
  });

  it("injected-token mode without token is not ready (missing-token)", () => {
    const report = probeScmReadiness({
      whichFn: (name) => (name === "gh" ? "/usr/bin/gh" : null),
      env: {},
      checkAuthStatus: false,
      githubAuthMode: "injected-token",
      runtimeReport: { runtimeMode: "cloud-headless" },
    });
    expect(report.ready).toBe(false);
    expect(report.authState).toBe("missing-token");
    expect(report.failureKind).toBe("missing_injected_token");
    expect(report.detail).toMatch(/applicable token/);
    expect(report.skippedGates.length).toBeGreaterThan(0);
  });

  it("injected-token mode with GH_TOKEN present is ready when auth status skipped", () => {
    const report = probeScmReadiness({
      whichFn: (name) => (name === "gh" ? "/usr/bin/gh" : null),
      env: { GH_TOKEN: "ghs_test_not_a_real_token" },
      checkAuthStatus: false,
      githubAuthMode: "injected-token",
      runtimeReport: { runtimeMode: "cloud-headless" },
    });
    expect(report.ready).toBe(true);
    expect(report.injectedTokenPresent).toBe(true);
    // Never echo the token value.
    expect(JSON.stringify(scmReadinessToDict(report))).not.toContain("ghs_test");
  });

  it("shallow path does not veto provisioned host-gh when aggregate auth status would fail", () => {
    let authCalls = 0;
    const report = probeScmReadiness({
      whichFn: (name) => (name === "gh" ? "/usr/bin/gh" : null),
      env: {},
      depth: "shallow",
      githubAuthMode: "host-gh",
      runtimeReport: { runtimeMode: "local-unsandboxed" },
      runGh: () => {
        authCalls += 1;
        return failProc("not logged in");
      },
    });
    expect(report.ready).toBe(true);
    expect(authCalls).toBe(0);
    expect(report.skippedGates).toEqual([]);
  });

  it("shallow path is ready when gh auth status succeeds", () => {
    const report = probeScmReadiness({
      whichFn: (name) => (name === "ghx" ? "/usr/bin/ghx" : null),
      env: {},
      depth: "shallow",
      githubAuthMode: "host-gh",
      runtimeReport: { runtimeMode: "local-unsandboxed" },
      runGh: () => okProc("Logged in"),
    });
    expect(report.ready).toBe(true);
    expect(report.authState).toBe("authenticated");
    expect(report.skippedGates).toEqual([]);
    expect(report.detail).toMatch(/SCM ready/);
  });

  it("deep path validates via github-auth-modes and surfaces login", () => {
    const report = probeScmReadiness({
      whichFn: (name) => (name === "gh" ? "/usr/bin/gh" : null),
      env: { GH_TOKEN: "tok" },
      depth: "deep",
      repo: "owner/name",
      githubAuthMode: "injected-token",
      runtimeReport: { runtimeMode: "cloud-headless" },
      runGh: (args) => {
        if (args[0] === "auth") return okProc();
        if (args[0] === "api" && args[1] === "user") return okProc('"alice"');
        if (args[0] === "api" && String(args[1]).startsWith("repos/")) return okProc("{}");
        return failProc("unexpected");
      },
    });
    expect(report.ready).toBe(true);
    expect(report.login).toBe("alice");
    expect(report.depth).toBe("deep");
  });

  it("deep path not-ready when API unreachable", () => {
    const report = probeScmReadiness({
      whichFn: (name) => (name === "gh" ? "/usr/bin/gh" : null),
      env: { GH_TOKEN: "tok" },
      depth: "deep",
      repo: "owner/name",
      githubAuthMode: "injected-token",
      runtimeReport: { runtimeMode: "cloud-headless" },
      runGh: (args) => {
        if (args[0] === "auth") return okProc();
        return failProc("network down");
      },
    });
    expect(report.ready).toBe(false);
    expect(report.failureKind).toBe("api_unreachable");
  });

  it("formatScmReadinessLines lists skipped gates when not ready", () => {
    const report = probeScmReadiness({
      whichFn: () => null,
      env: {},
      checkAuthStatus: false,
      githubAuthMode: "host-gh",
      runtimeReport: { runtimeMode: "cursor-native-sandbox" },
    });
    const lines = formatScmReadinessLines(report);
    expect(lines[0]).toMatch(/^\[deft scm\]/);
    expect(lines.some((l) => l.includes("skipped gates:"))).toBe(true);
    expect(lines.some((l) => l.includes("#2275"))).toBe(true);
  });

  it("formatScmReadinessLines is a single ready line when ready", () => {
    const report = probeScmReadiness({
      whichFn: (name) => (name === "gh" ? "/bin/gh" : null),
      env: {},
      checkAuthStatus: false,
      githubAuthMode: "host-gh",
      runtimeReport: { runtimeMode: "local-unsandboxed" },
    });
    const lines = formatScmReadinessLines(report);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/SCM ready|binary present/);
  });

  it("scmNotReadyError throws ScmStubError with #2275 remediation", () => {
    const report = probeScmReadiness({
      whichFn: () => null,
      env: {},
      checkAuthStatus: false,
      githubAuthMode: "host-gh",
      runtimeReport: { runtimeMode: "cloud-headless" },
    });
    const err = scmNotReadyError(report);
    expect(err).toBeInstanceOf(ScmStubError);
    expect(err.message).toMatch(/#2275/);
    expect(err.message).toMatch(/skipped_gates|execution env|GH_TOKEN/);
  });

  it("assertScmBinaryPresent returns binary or throws fail-loud", () => {
    expect(assertScmBinaryPresent((n) => (n === "gh" ? "/bin/gh" : null))).toBe("gh");
    expect(() => assertScmBinaryPresent(() => null)).toThrow(ScmStubError);
    expect(() => assertScmBinaryPresent(() => null)).toThrow(/#2275|execution env/);
  });

  it("requireScmReady throws when unauthenticated and caches when ready", async () => {
    const { requireScmReady, clearScmReadyCache } = await import("./readiness.js");
    clearScmReadyCache();
    expect(() =>
      requireScmReady({
        force: true,
        whichFn: () => null,
        env: {},
        githubAuthMode: "host-gh",
        runtimeReport: { runtimeMode: "local-unsandboxed" },
      }),
    ).toThrow(ScmStubError);

    clearScmReadyCache();
    const report = requireScmReady({
      force: true,
      whichFn: (n) => (n === "gh" ? "/bin/gh" : null),
      env: {},
      githubAuthMode: "host-gh",
      runtimeReport: { runtimeMode: "local-unsandboxed" },
      runGh: () => ({ args: [], returncode: 0, stdout: "ok", stderr: "" }),
    });
    expect(report.ready).toBe(true);
    // Cached path returns same ready report without re-running.
    const again = requireScmReady();
    expect(again.ready).toBe(true);
    clearScmReadyCache();
  });

  it("scmReadinessToDict uses snake_case and never includes secrets", () => {
    const report = probeScmReadiness({
      whichFn: (name) => (name === "gh" ? "/bin/gh" : null),
      env: { GITHUB_TOKEN: "super-secret-value-xyz" },
      checkAuthStatus: false,
      githubAuthMode: "injected-token",
      runtimeReport: { runtimeMode: "cloud-headless" },
    });
    const dict = scmReadinessToDict(report);
    expect(dict.auth_state).toBeDefined();
    expect(dict.github_auth_mode).toBe("injected-token");
    expect(dict.injected_token_present).toBe(true);
    expect(JSON.stringify(dict)).not.toContain("super-secret-value-xyz");
  });
});

/**
 * Readiness-level regressions for #3859.
 *
 * These are diagnostics, not the safety case. The safety case is that host
 * credentials require either a non-Cursor runtime or an explicit selection, and
 * that a positive managed-runtime read outranks both. Each case drives the real
 * intake classifier so the assertion spans classification, auth-mode inference,
 * and the readiness verdict rather than one seam.
 */
const NEVER_MANAGED: ManagedRuntimeProbe = () => ({
  verdict: "unavailable",
  socketPath: null,
  detail: "test: no metadata socket",
});
const REPORTS_MANAGED: ManagedRuntimeProbe = () => ({
  verdict: "managed",
  socketPath: "/tmp/cursor.sock",
  detail: "test: agent/runtime reported managed",
});

function runtimeFor(
  environ: NodeJS.ProcessEnv,
  managedRuntimeProbe: ManagedRuntimeProbe = NEVER_MANAGED,
): RuntimeCapabilityReport {
  return probeRuntimeCapabilities(environ, { managedRuntimeProbe });
}

function readinessFor(
  environ: NodeJS.ProcessEnv,
  managedRuntimeProbe: ManagedRuntimeProbe = NEVER_MANAGED,
) {
  return probeScmReadiness({
    whichFn: (name) => (name === "gh" ? "/usr/bin/gh" : null),
    env: environ,
    runtimeReport: runtimeFor(environ, managedRuntimeProbe),
    runGh: () => okProc("Logged in to github.com account octocat"),
  });
}

describe("provisioning trust does not authorize by runtime (#5016)", () => {
  const LOCAL_DESKTOP = { CURSOR_AGENT: "1", CURSOR_CONVERSATION_ID: "abc" };

  it("admits host-gh on an ambiguous Cursor desktop without an opt-in", () => {
    const report = readinessFor({ ...LOCAL_DESKTOP });
    expect(report.runtimeMode).toBe("cloud-headless");
    expect(report.githubAuthMode).toBe("host-gh");
    expect(report.ready).toBe(true);
    expect(report.skippedGates).toEqual([]);
    expect(scmReadinessToDict(report).runtime_mode_reason).toBe("cursor-marker-runtime-ambiguous");
  });

  it("keeps runtime classification diagnostic when not ready for other reasons", () => {
    const report = probeScmReadiness({
      whichFn: () => null,
      env: LOCAL_DESKTOP,
      runtimeReport: runtimeFor(LOCAL_DESKTOP),
    });
    expect(report.ready).toBe(false);
    const lines = formatScmReadinessLines(report).join("\n");
    expect(lines).toContain("skipped gates:");
    expect(lines).toContain("reason: cursor-marker-runtime-ambiguous");
    expect(lines).toMatch(/diagnostic only|provisioned source/i);
    expect(lines).not.toContain("DEFT_GITHUB_AUTH_MODE=host-gh");
  });

  it("identical credentials yield identical auth outcomes across local/CI/managed", () => {
    const managed = readinessFor({ CURSOR_AGENT: "1" }, REPORTS_MANAGED);
    const ci = readinessFor({ GITHUB_ACTIONS: "true" });
    const desktop = readinessFor({ ...LOCAL_DESKTOP });
    expect(managed.ready).toBe(true);
    expect(ci.ready).toBe(true);
    expect(desktop.ready).toBe(true);
    expect(managed.githubAuthMode).toBe("host-gh");
    expect(ci.githubAuthMode).toBe("host-gh");
    expect(desktop.githubAuthMode).toBe("host-gh");
    expect(scmReadinessToDict(managed).runtime_mode_reason).toBe("cursor-managed-runtime-probe");
    expect(scmReadinessToDict(ci).runtime_mode_reason).toBe("ci-marker");
  });
});

const INSTALLATION_USER_403: CompletedProcess = {
  args: [],
  returncode: 1,
  stdout: '{"message":"Resource not accessible by integration","status":"403"}',
  stderr: "gh: Resource not accessible by integration (HTTP 403)",
};

describe("requireScmReady credential-class ban (#3858)", () => {
  const whichGh = (name: string) => (name === "gh" ? "/usr/bin/gh" : null);

  afterEach(() => {
    clearScmReadyCache();
    vi.unstubAllEnvs();
  });

  it("admits unassigned installation authentication after a well-formed probe", () => {
    clearScmReadyCache();
    const report = requireScmReady({
      force: true,
      checkAuthStatus: true,
      depth: "deep",
      repo: "owner/name",
      expectedPrincipal: null,
      whichFn: whichGh,
      env: {},
      githubAuthMode: "host-gh",
      runtimeReport: { runtimeMode: "local-unsandboxed" },
      runGh: (args) => {
        const joined = args.join(" ");
        if (args[0] === "auth") return okProc("Logged in");
        if (joined.includes("user") && !joined.includes("installation"))
          return INSTALLATION_USER_403;
        if (joined.includes("installation/repositories")) {
          return okProc('{"total_count":1,"repositories":[]}');
        }
        if (joined.includes("repos/owner/name")) return okProc("{}");
        return failProc(`unexpected ${args.join(" ")}`);
      },
    });
    expect(report.ready).toBe(true);
    expect(report.login).toBeNull();
  });

  it("treats an installation-shaped /user 403 without a successful probe as not ready", () => {
    clearScmReadyCache();
    expect(() =>
      requireScmReady({
        force: true,
        checkAuthStatus: true,
        depth: "deep",
        repo: "owner/name",
        expectedPrincipal: null,
        whichFn: whichGh,
        env: {},
        githubAuthMode: "host-gh",
        runtimeReport: { runtimeMode: "local-unsandboxed" },
        runGh: (args) => {
          if (args[0] === "auth") return okProc("Logged in");
          if (args.join(" ").includes("user")) return INSTALLATION_USER_403;
          return failProc(`unexpected ${args.join(" ")}`);
        },
      }),
    ).toThrow(/not ready|installation|unauthenticated|Requires authentication/i);
  });

  it("does not reuse a cached shallow-ready report for a later deep 403", () => {
    clearScmReadyCache();
    let userCalls = 0;
    const runGh = (args: readonly string[]) => {
      if (args[0] === "auth") return okProc("Logged in");
      if (args[0] === "api" && args[1] === "user") {
        userCalls += 1;
        return INSTALLATION_USER_403;
      }
      return failProc(`unexpected ${args.join(" ")}`);
    };
    const common = {
      whichFn: whichGh,
      env: {},
      githubAuthMode: "host-gh" as const,
      runtimeReport: { runtimeMode: "local-unsandboxed" as const },
      runGh,
      repo: "owner/name",
      expectedPrincipal: null as const,
      checkAuthStatus: true as const,
    };
    const shallow = requireScmReady({ ...common, depth: "shallow", force: true });
    expect(shallow.ready).toBe(true);
    expect(userCalls).toBe(0);
    expect(() => requireScmReady({ ...common, depth: "deep" })).toThrow(ScmStubError);
    expect(userCalls).toBe(1);
  });

  it("does not let DEFT_SCM_SKIP_AUTH_PROBE authorize production when a token is present", () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("DEFT_SCM_SKIP_AUTH_PROBE", "1");
    clearScmReadyCache();
    expect(() =>
      requireScmReady({
        force: true,
        depth: "deep",
        repo: "owner/name",
        expectedPrincipal: null,
        whichFn: whichGh,
        env: { GH_TOKEN: "ghs_install_not_a_real_token" },
        githubAuthMode: "injected-token",
        runtimeReport: { runtimeMode: "cloud-headless" },
        runGh: (args) => {
          if (args[0] === "auth") return okProc();
          if (args.join(" ").includes("user")) return INSTALLATION_USER_403;
          return failProc(`unexpected ${args.join(" ")}`);
        },
      }),
    ).toThrow(ScmStubError);
  });

  it("reuses a cached deep-ready report for a later shallow request", () => {
    clearScmReadyCache();
    let authCalls = 0;
    const runGh = (args: readonly string[]) => {
      if (args[0] === "auth") {
        authCalls += 1;
        return okProc("Logged in");
      }
      if (args[0] === "api" && args[1] === "user") return okProc('"alice"');
      if (args[0] === "api" && String(args[1]).startsWith("repos/")) return okProc("{}");
      return failProc(`unexpected ${args.join(" ")}`);
    };
    const common = {
      whichFn: whichGh,
      env: {},
      githubAuthMode: "host-gh" as const,
      runtimeReport: { runtimeMode: "local-unsandboxed" as const },
      runGh,
      repo: "owner/name",
      expectedPrincipal: null as const,
      checkAuthStatus: true as const,
    };
    const deep = requireScmReady({ ...common, depth: "deep", force: true });
    expect(deep.ready).toBe(true);
    expect(deep.depth).toBe("deep");
    const afterDeep = authCalls;
    const shallow = requireScmReady({ ...common, depth: "shallow" });
    expect(shallow.ready).toBe(true);
    expect(shallow.depth).toBe("deep");
    expect(authCalls).toBe(afterDeep);
  });

  it("does not reuse a cached ready report for a different repo", () => {
    clearScmReadyCache();
    const repos: string[] = [];
    const runGh = (args: readonly string[]) => {
      if (args[0] === "auth") return okProc("Logged in");
      if (args[0] === "api" && args[1] === "user") return okProc('"alice"');
      if (args[0] === "api" && String(args[1]).startsWith("repos/")) {
        repos.push(String(args[1]));
        return okProc("{}");
      }
      return failProc(`unexpected ${args.join(" ")}`);
    };
    const common = {
      whichFn: whichGh,
      env: {},
      githubAuthMode: "host-gh" as const,
      runtimeReport: { runtimeMode: "local-unsandboxed" as const },
      runGh,
      expectedPrincipal: null as const,
      checkAuthStatus: true as const,
      depth: "deep" as const,
    };
    requireScmReady({ ...common, repo: "owner/one", force: true });
    requireScmReady({ ...common, repo: "owner/two" });
    expect(repos).toEqual(["repos/owner/one", "repos/owner/two"]);
    requireScmReady({ ...common, repo: "owner/one" });
    expect(repos).toEqual(["repos/owner/one", "repos/owner/two"]);
  });

  it("passes --repo other than origin through to the validator", () => {
    clearScmReadyCache();
    const seen: string[][] = [];
    const report = requireScmReady({
      force: true,
      checkAuthStatus: true,
      depth: "deep",
      repo: "other/thing",
      expectedPrincipal: null,
      whichFn: whichGh,
      env: {},
      githubAuthMode: "host-gh",
      runtimeReport: { runtimeMode: "local-unsandboxed" },
      runGh: (args) => {
        seen.push([...args]);
        if (args[0] === "auth") return okProc("Logged in");
        if (args[0] === "api" && args[1] === "user") return okProc('"alice"');
        if (args[0] === "api" && args[1] === "repos/other/thing") return okProc("{}");
        return failProc(`unexpected ${args.join(" ")}`);
      },
    });
    expect(report.ready).toBe(true);
    expect(report.login).toBe("alice");
    expect(seen.some((a) => a[0] === "api" && a[1] === "repos/other/thing")).toBe(true);
  });
});

const REGISTERED: WorkerAuthAssignment = {
  schema_version: Number.parseInt("1", 10),
  dispatch_id: "dispatch-1",
  story_id: "story-a",
  worktree_path: "/tmp/worker",
  github_auth_mode: "host-gh",
  expected_principal: { kind: "user", login: "worker-a" },
  credential_delivery_id: null,
};

function assignmentRead(assignment: WorkerAuthAssignment | null): ReadWorkerAuthAssignmentResult {
  return { ok: true, assignment, commonDir: "/tmp/git" };
}

describe("requireScmReady registered worker (#3663)", () => {
  it("T3: assigned login A refuses observed login B even when the caller supplied null", () => {
    clearScmReadyCache();
    expect(() =>
      requireScmReady({
        force: true,
        cwd: "/tmp/worker",
        env: {},
        whichFn: (n) => (n === "gh" ? "/bin/gh" : null),
        expectedPrincipal: null,
        repo: "acme/widgets",
        readWorkerAuthAssignment: () => assignmentRead(REGISTERED),
        runGh: (args) => {
          if (args[0] === "auth")
            return { args: [...args], returncode: 0, stdout: "ok", stderr: "" };
          if (args[0] === "api" && args[1] === "user") {
            return { args: [...args], returncode: 0, stdout: '{"login":"worker-b"}', stderr: "" };
          }
          return { args: [...args], returncode: 0, stdout: "{}", stderr: "" };
        },
      }),
    ).toThrow(/principal_mismatch|identity mismatch|worker-a/);
  });

  it("T6: skip flags and a prior unregistered cache do not bypass a registered worker", () => {
    clearScmReadyCache();
    requireScmReady({
      force: true,
      cwd: "/tmp/other",
      env: {},
      whichFn: (n) => (n === "gh" ? "/bin/gh" : null),
      githubAuthMode: "host-gh",
      runtimeReport: { runtimeMode: "local-unsandboxed" },
      runGh: () => ({ args: [], returncode: 0, stdout: "ok", stderr: "" }),
      readWorkerAuthAssignment: () => assignmentRead(null),
    });
    expect(() =>
      requireScmReady({
        cwd: "/tmp/worker",
        env: { VITEST: "true", DEFT_SCM_SKIP_AUTH_PROBE: "1" },
        skipReadiness: true,
        whichFn: (n) => (n === "gh" ? "/bin/gh" : null),
        expectedPrincipal: null,
        readWorkerAuthAssignment: () => assignmentRead(REGISTERED),
        runGh: (args) => {
          if (args[0] === "auth")
            return { args: [...args], returncode: 1, stdout: "", stderr: "no" };
          return { args: [...args], returncode: 1, stdout: "", stderr: "no" };
        },
      }),
    ).toThrow(/SCM not ready|gh auth status failed|worker auth failed|unauthenticated/);
  });

  it("unregistered skipReadiness does not consult git origin", () => {
    clearScmReadyCache();
    const report = requireScmReady({
      skipReadiness: true,
      cwd: "/tmp/unregistered-skip",
      env: {},
      whichFn: (n) => (n === "gh" ? "/bin/gh" : null),
      host: "github.com",
      runtimeReport: { runtimeMode: "local-unsandboxed" },
      readWorkerAuthAssignment: () => assignmentRead(null),
    });
    expect(report.ready).toBe(true);
    expect(report.detail).toMatch(/skipped for unregistered/);
  });

  it("T8: unregistered explicit-null keeps identity suppression", () => {
    clearScmReadyCache();
    const report = requireScmReady({
      force: true,
      cwd: "/tmp/unregistered",
      env: {},
      whichFn: (n) => (n === "gh" ? "/bin/gh" : null),
      expectedPrincipal: null,
      githubAuthMode: "host-gh",
      runtimeReport: { runtimeMode: "local-unsandboxed" },
      readWorkerAuthAssignment: () => assignmentRead(null),
      runGh: () => ({ args: [], returncode: 0, stdout: "ok", stderr: "" }),
    });
    expect(report.ready).toBe(true);
    expect(report.login).toBeNull();
  });

  it("matching host identity with no ambient token proceeds", () => {
    clearScmReadyCache();
    const report = requireScmReady({
      force: true,
      cwd: "/tmp/worker",
      env: {},
      whichFn: (n) => (n === "gh" ? "/bin/gh" : null),
      repo: "acme/widgets",
      expectedPrincipal: null,
      readWorkerAuthAssignment: () => assignmentRead(REGISTERED),
      runGh: (args) => {
        if (args[0] === "auth") return { args: [...args], returncode: 0, stdout: "ok", stderr: "" };
        if (args[0] === "api" && args[1] === "user") {
          return { args: [...args], returncode: 0, stdout: '{"login":"worker-a"}', stderr: "" };
        }
        if (String(args[1] ?? "").includes("acme/widgets")) {
          return { args: [...args], returncode: 0, stdout: "{}", stderr: "" };
        }
        return {
          args: [...args],
          returncode: 1,
          stdout: "",
          stderr: `unexpected ${args.join(" ")}`,
        };
      },
    });
    expect(report.ready).toBe(true);
    expect(report.login).toBe("worker-a");
  });

  it("injected matching delivery id and principal proceeds", () => {
    clearScmReadyCache();
    const injected: WorkerAuthAssignment = {
      ...REGISTERED,
      github_auth_mode: "injected-token",
      credential_delivery_id: "del-1",
    };
    const report = requireScmReady({
      force: true,
      cwd: "/tmp/worker",
      env: {
        GH_TOKEN: "gho_not_a_real_token",
        [ENV_WORKER_CREDENTIAL_DELIVERY_ID]: "del-1",
      },
      whichFn: (n) => (n === "gh" ? "/bin/gh" : null),
      repo: "acme/widgets",
      expectedPrincipal: null,
      readWorkerAuthAssignment: () => assignmentRead(injected),
      runGh: (args) => {
        if (args[0] === "auth") return { args: [...args], returncode: 0, stdout: "ok", stderr: "" };
        if (args[0] === "api" && args[1] === "user") {
          return { args: [...args], returncode: 0, stdout: '{"login":"worker-a"}', stderr: "" };
        }
        return { args: [...args], returncode: 0, stdout: "{}", stderr: "" };
      },
    });
    expect(report.ready).toBe(true);
    expect(report.login).toBe("worker-a");
  });

  it("assigned host-gh is admitted on a cloud-classified runtime", () => {
    clearScmReadyCache();
    const report = requireScmReady({
      force: true,
      cwd: "/tmp/worker",
      env: { CURSOR_AGENT: "1" },
      whichFn: (n) => (n === "gh" ? "/bin/gh" : null),
      repo: "acme/widgets",
      runtimeReport: { runtimeMode: "cloud-headless", runtimeModeReason: "ci-marker" },
      readWorkerAuthAssignment: () => assignmentRead(REGISTERED),
      runGh: (args) => {
        if (args.join(" ").includes("user")) {
          return { args: [...args], returncode: 0, stdout: '{"login":"worker-a"}', stderr: "" };
        }
        return { args: [...args], returncode: 0, stdout: "{}", stderr: "" };
      },
    });
    expect(report.ready).toBe(true);
    expect(report.login).toBe("worker-a");
  });

  it("assigned host-gh rejects an applicable ambient token even when login matches", () => {
    clearScmReadyCache();
    expect(() =>
      requireScmReady({
        force: true,
        cwd: "/tmp/worker",
        env: { GH_TOKEN: "gho_not_a_real_token" },
        whichFn: (n) => (n === "gh" ? "/bin/gh" : null),
        repo: "acme/widgets",
        readWorkerAuthAssignment: () => assignmentRead(REGISTERED),
        runGh: (args) => {
          if (args.join(" ").includes("user")) {
            return { args: [...args], returncode: 0, stdout: '{"login":"worker-a"}', stderr: "" };
          }
          return { args: [...args], returncode: 0, stdout: "{}", stderr: "" };
        },
      }),
    ).toThrow(/ambient_token_conflict|applicable ambient token/i);
  });

  it("does not treat a GHES token as a github.com source conflict", () => {
    clearScmReadyCache();
    const report = requireScmReady({
      force: true,
      cwd: "/tmp/worker",
      env: { GH_ENTERPRISE_TOKEN: "ghe_not_this_host" },
      whichFn: (n) => (n === "gh" ? "/bin/gh" : null),
      repo: "acme/widgets",
      readWorkerAuthAssignment: () => assignmentRead(REGISTERED),
      runGh: (args) => {
        if (args.join(" ").includes("user")) {
          return { args: [...args], returncode: 0, stdout: '{"login":"worker-a"}', stderr: "" };
        }
        return { args: [...args], returncode: 0, stdout: "{}", stderr: "" };
      },
    });
    expect(report.ready).toBe(true);
  });

  it("re-probes when the applicable token fingerprint changes", () => {
    clearScmReadyCache();
    let userCalls = 0;
    const runGh = (args: readonly string[]) => {
      if (args.join(" ").includes("user")) {
        userCalls += 1;
        return okProc('"alice"');
      }
      if (args.join(" ").includes("repos/")) return okProc("{}");
      return failProc(`unexpected ${args.join(" ")}`);
    };
    const common = {
      whichFn: (n: string) => (n === "gh" ? "/usr/bin/gh" : null),
      githubAuthMode: "injected-token" as const,
      runtimeReport: { runtimeMode: "local-unsandboxed" as const },
      runGh,
      repo: "owner/name",
      expectedPrincipal: null as const,
      checkAuthStatus: true as const,
      depth: "deep" as const,
      readWorkerAuthAssignment: () => assignmentRead(null),
    };
    requireScmReady({ ...common, env: { GH_TOKEN: "one" }, force: true });
    expect(userCalls).toBe(1);
    requireScmReady({ ...common, env: { GH_TOKEN: "one" } });
    expect(userCalls).toBe(1);
    requireScmReady({ ...common, env: { GH_TOKEN: "two" } });
    expect(userCalls).toBe(2);
  });
});
