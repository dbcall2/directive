import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CompletedProcess } from "../scm/call.js";
import {
  containsTokenShapedText,
  deriveValidationRepo,
  ENV_EXPECTED_GITHUB_LOGIN,
  type ExpectedGithubWorkerPrincipal,
  FAILURE_API_UNREACHABLE,
  FAILURE_INSTALLATION_IDENTITY_UNVERIFIABLE,
  FAILURE_INVALID_MODE,
  FAILURE_MISSING_INJECTED_TOKEN,
  FAILURE_MISSING_TARGET_REPO,
  FAILURE_PRINCIPAL_MISMATCH,
  FAILURE_REPO_ACCESS,
  findInjectedToken,
  formatUserApiFailureDetail,
  type GhRunner,
  githubApiPath,
  githubAuthModesMain,
  hostStoreIdentityFingerprint,
  INSTALLATION_IDENTITY_ISSUE_URL,
  inferGithubAuthMode,
  isInstallationUserEndpointInapplicable,
  PRINCIPAL_KIND_USER,
  parseLogin,
  parseOwnerRepoSlug,
  resultToDict,
  validateGithubAuth,
  validateGithubAuthForWorker,
  validateHostGhMode,
  validateInjectedTokenMode,
} from "./github-auth-modes.js";
import { mainEntry as githubAuthModesCliMain } from "./github-auth-modes-cli.js";
import {
  RUNTIME_MODE_CLOUD_HEADLESS,
  RUNTIME_MODE_CURSOR_NATIVE_SANDBOX,
} from "./platform-capabilities.js";

function proc(
  returncode: number,
  stdout = "",
  stderr = "",
  args: readonly string[] = [],
): CompletedProcess {
  return { returncode, stdout, stderr, args: [...args] };
}

const INSTALLATION_REPOS_OK = '{"total_count":1,"repositories":[{"full_name":"acme/widgets"}]}';

function stubGh(options: {
  authCode?: number;
  user?: { code: number; stdout?: string; stderr?: string };
  repoCode?: number;
  installation?: { code: number; stdout?: string; stderr?: string };
}): GhRunner {
  return (args) => {
    if (args[0] === "auth") {
      return proc(options.authCode ?? 0, "ok", "", args);
    }
    const apiPath = githubApiPath(args);
    if (apiPath === "user") {
      const user = options.user ?? { code: 0, stdout: '{"login":"octo"}' };
      return proc(user.code, user.stdout ?? "", user.stderr ?? "", args);
    }
    if (apiPath === "installation/repositories") {
      const installation = options.installation ?? {
        code: 1,
        stdout: "",
        stderr: `unexpected JWT App probe: ${args.join(" ")}`,
      };
      return proc(installation.code, installation.stdout ?? "", installation.stderr ?? "", args);
    }
    if (apiPath?.startsWith("repos/")) {
      const code = options.repoCode ?? 0;
      return proc(code, code === 0 ? "{}" : "", code === 0 ? "" : "denied", args);
    }
    return proc(1, "", `unexpected: ${args.join(" ")}`, args);
  };
}

const TARGET_REPO = "acme/widgets";
const USER_PRINCIPAL: ExpectedGithubWorkerPrincipal = { kind: PRINCIPAL_KIND_USER, login: "octo" };

const INSTALLATION_USER_403 = {
  code: 1,
  stdout: '{"message":"Resource not accessible by integration","status":"403"}',
  stderr: "gh: Resource not accessible by integration (HTTP 403)",
};

describe("github-auth-modes", () => {
  it("finds injected token env vars", () => {
    expect(findInjectedToken({ GH_TOKEN: "secret" })).toBe("secret");
    expect(findInjectedToken({})).toBeNull();
  });

  it("infers injected-token from an applicable token, not from runtime", () => {
    expect(inferGithubAuthMode({ GH_TOKEN: "t" })).toBe("injected-token");
    expect(inferGithubAuthMode({})).toBe("host-gh");
    expect(inferGithubAuthMode({ GH_ENTERPRISE_TOKEN: "t" })).toBe("host-gh");
    expect(inferGithubAuthMode({ GH_ENTERPRISE_TOKEN: "t" }, { host: "ghe.example.com" })).toBe(
      "injected-token",
    );
  });

  it("rejects unknown auth mode", () => {
    const result = validateGithubAuth("bogus", { environ: {} });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe(FAILURE_INVALID_MODE);
  });

  it("validates host-gh with stub runner", () => {
    const result = validateGithubAuth("host-gh", {
      environ: {},
      repo: TARGET_REPO,
      runGh: stubGh({}),
    });
    expect(result.ok).toBe(true);
    expect(result.login).toBe("octo");
    expect(result.validationRepo).toBe(TARGET_REPO);
  });

  it("defaultRunGh path fails closed when live gh is unavailable (#3027)", () => {
    const result = validateGithubAuth("host-gh", {
      environ: { PATH: "" },
      repo: TARGET_REPO,
      readGitRemote: () => null,
    });
    expect(result.ok).toBe(false);
    expect(result.detail.length).toBeGreaterThan(0);
  });

  it("validates injected-token mode when token present (#3027)", () => {
    const result = validateGithubAuth("injected-token", {
      environ: { GH_TOKEN: "ghs_test_not_real" },
      repo: TARGET_REPO,
      runGh: stubGh({ user: { code: 0, stdout: '{"login":"bot"}' } }),
    });
    expect(result.ok).toBe(true);
    expect(result.login).toBe("bot");
  });

  it("injected-token missing token fails closed (#3027)", () => {
    const result = validateInjectedTokenMode({});
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe(FAILURE_MISSING_INJECTED_TOKEN);
  });

  it("injected-token API failure includes sandbox remediation (#3027 / #5016)", () => {
    const result = validateInjectedTokenMode(
      { GH_TOKEN: "t" },
      {
        runtimeMode: RUNTIME_MODE_CURSOR_NATIVE_SANDBOX,
        repo: TARGET_REPO,
        runGh: stubGh({ user: { code: 1, stdout: "", stderr: "timeout" } }),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe(FAILURE_API_UNREACHABLE);
    expect(result.remediation).toMatch(/sandbox/i);
  });

  it("injected-token API unreachable and repo-access branches (#3027)", () => {
    const unreachable = validateInjectedTokenMode(
      { GITHUB_TOKEN: "t" },
      {
        repo: TARGET_REPO,
        runGh: stubGh({
          user: { code: 1, stdout: "", stderr: "timeout" },
        }),
      },
    );
    expect(unreachable.failureKind).toBe(FAILURE_API_UNREACHABLE);
    expect(unreachable.detail).toMatch(/unreachable/i);

    const noRepo = validateInjectedTokenMode(
      { GH_TOKEN: "t" },
      {
        repo: TARGET_REPO,
        expectedPrincipal: { kind: PRINCIPAL_KIND_USER, login: "u" },
        runGh: stubGh({
          user: { code: 0, stdout: '{"login":"u"}' },
          repoCode: 1,
        }),
      },
    );
    expect(noRepo.failureKind).toBe(FAILURE_REPO_ACCESS);
    expect(noRepo.login).toBe("u");
    expect(noRepo.remediation).toMatch(/repo-access|repository/i);
  });

  it("host-gh mode API failure and bare-string login parse (#3027 / #5016)", () => {
    const badAuth = validateHostGhMode(
      {},
      {
        repo: TARGET_REPO,
        runGh: () => proc(1, "", "auth"),
      },
    );
    expect(badAuth.ok).toBe(false);
    expect(badAuth.failureKind).toBe(FAILURE_API_UNREACHABLE);

    const ok = validateHostGhMode(
      {},
      {
        repo: TARGET_REPO,
        runGh: stubGh({ user: { code: 0, stdout: '"octocat"' } }),
      },
    );
    expect(ok.ok).toBe(true);
    expect(ok.login).toBe("octocat");
  });

  it("host-gh invalid repo slug fails closed (#3665)", () => {
    const result = validateHostGhMode(
      {},
      {
        repo: "not-a-slug",
        runGh: stubGh({}),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe(FAILURE_MISSING_TARGET_REPO);
    expect(result.detail).toMatch(/invalid repository slug/);
  });

  it("host-gh API unreachable and repo-access failure branches (#3027)", () => {
    const unreachable = validateHostGhMode(
      {},
      {
        repo: TARGET_REPO,
        runGh: stubGh({
          user: { code: 1, stdout: "", stderr: "timeout" },
        }),
      },
    );
    expect(unreachable.failureKind).toBe(FAILURE_API_UNREACHABLE);
    expect(unreachable.detail).toMatch(/\/user failed/);
    expect(unreachable.detail).toMatch(/unreachable/i);

    const noRepo = validateHostGhMode(
      {},
      {
        repo: TARGET_REPO,
        runtimeMode: RUNTIME_MODE_CURSOR_NATIVE_SANDBOX,
        runGh: stubGh({
          user: { code: 0, stdout: '{"login":"u"}' },
          repoCode: 1,
        }),
      },
    );
    expect(noRepo.failureKind).toBe(FAILURE_REPO_ACCESS);
    expect(noRepo.login).toBe("u");
    expect(noRepo.remediation).toMatch(/sandbox/i);
    expect(noRepo.remediation).toMatch(/repo-access|repository/i);
  });

  it("parseLogin empty and non-login object paths fail closed (#3665)", () => {
    const emptyLogin = validateHostGhMode(
      {},
      {
        repo: TARGET_REPO,
        runGh: stubGh({ user: { code: 0, stdout: "   " } }),
      },
    );
    expect(emptyLogin.ok).toBe(false);
    expect(emptyLogin.failureKind).toBe(FAILURE_PRINCIPAL_MISMATCH);
    expect(emptyLogin.login).toBeNull();

    const noLoginField = validateHostGhMode(
      {},
      {
        repo: TARGET_REPO,
        runGh: stubGh({ user: { code: 0, stdout: '{"id":1}' } }),
      },
    );
    expect(noLoginField.ok).toBe(false);
    expect(noLoginField.failureKind).toBe(FAILURE_PRINCIPAL_MISMATCH);

    const bareText = validateHostGhMode(
      {},
      {
        repo: TARGET_REPO,
        runGh: stubGh({ user: { code: 0, stdout: "not-json-login" } }),
      },
    );
    expect(bareText.ok).toBe(false);
    expect(bareText.login).toBeNull();
    expect(bareText.detail).not.toContain("not-json-login");
  });

  it("parseLogin accepts ANSI-colored /user JSON and rejects token-shaped login (#3664)", () => {
    const ansi =
      '\u001b[1;37m{\u001b[m\n  \u001b[1;34m"login"\u001b[m: \u001b[32m"octocat"\u001b[m\n\u001b[1;37m}\u001b[m\n';
    expect(parseLogin(ansi)).toBe("octocat");
    expect(parseLogin('{"login":"ghs_liveinstallationtokenvalue"}')).toBeNull();
    expect(parseLogin("")).toBeNull();
    expect(containsTokenShapedText("Token: ghs_liveinstallationtokenvalue")).toBe(true);
    expect(containsTokenShapedText("ghr_refreshshaped")).toBe(true);
    expect(containsTokenShapedText("ghs_liveinstallationtokenvalue")).toBe(true);
  });

  it("redacts every token-shaped occurrence in CLI and JSON diagnostics (#3664)", () => {
    const tokenA = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`;
    const tokenB = `gho_${"Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2"}`;
    const dualRepo = `${tokenA} ${tokenB}`;
    const chunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      const jsonCode = githubAuthModesMain({
        githubAuthMode: "host-gh",
        repo: dualRepo,
        json: true,
        runGh: stubGh({}),
      });
      expect(jsonCode).toBe(1);
      const jsonOut = chunks.join("");
      expect(jsonOut).not.toContain(tokenA);
      expect(jsonOut).not.toContain(tokenB);
      expect(jsonOut).toMatch(/\[redacted\].*\[redacted\]/s);

      chunks.length = 0;
      const cliCode = githubAuthModesMain({
        githubAuthMode: "host-gh",
        repo: dualRepo,
        json: false,
        runGh: stubGh({}),
      });
      expect(cliCode).toBe(1);
      const cliOut = chunks.join("");
      expect(cliOut).not.toContain(tokenA);
      expect(cliOut).not.toContain(tokenB);
      expect(cliOut).toMatch(/\[redacted\].*\[redacted\]/s);
    } finally {
      stdout.mockRestore();
    }

    const fromEnv = validateHostGhMode(
      { GH_REPO: dualRepo },
      { runGh: stubGh({}), readGitRemote: () => null },
    );
    expect(fromEnv.ok).toBe(false);
    expect(fromEnv.detail).not.toContain(tokenA);
    expect(fromEnv.detail).not.toContain(tokenB);
    expect(fromEnv.detail).toMatch(/\[redacted\].*\[redacted\]/s);
  });

  it("does not emit raw gh streams or token-shaped text in detail/login/CLI (#3664 R1/R4)", () => {
    const tokenOut = "Token: ghs_liveinstallationtokenvalue";
    const ansiUser =
      '\u001b[1;37m{\u001b[m"login":"octo","token":"gho_shouldneverappear"\u001b[1;37m}\u001b[m';
    const failedAuth = validateHostGhMode(
      {},
      {
        repo: TARGET_REPO,
        runGh: (args) => {
          if (args[0] === "auth") {
            return proc(1, tokenOut, `stderr ${tokenOut}`, args);
          }
          return proc(1, "", "unexpected", args);
        },
      },
    );
    expect(failedAuth.ok).toBe(false);
    expect(failedAuth.failureKind).toBe(FAILURE_API_UNREACHABLE);
    expect(JSON.stringify(resultToDict(failedAuth))).not.toMatch(/ghs_|gho_|ghr_|github_pat_/i);
    expect(failedAuth.detail).not.toContain(tokenOut);
    expect(failedAuth.detail).not.toContain("stderr");

    const userFail = formatUserApiFailureDetail(
      "host-gh",
      proc(1, tokenOut, `gh: boom ${tokenOut}`),
    );
    expect(userFail).not.toContain(tokenOut);
    expect(userFail).not.toMatch(/ghs_/);
    expect(userFail).toMatch(/exit 1|unreachable|\/user failed|\[redacted\]/);

    const nonJsonCause = formatUserApiFailureDetail(
      "host-gh",
      proc(1, "", "gh: HTTP 401: Bad credentials (https://api.github.com/user)"),
    );
    expect(nonJsonCause).toMatch(/HTTP 401|Bad credentials/);
    expect(nonJsonCause).not.toMatch(/exit 1/);

    const okAnsi = validateHostGhMode(
      {},
      {
        repo: TARGET_REPO,
        runGh: stubGh({ user: { code: 0, stdout: ansiUser } }),
      },
    );
    expect(okAnsi.ok).toBe(true);
    expect(okAnsi.login).toBe("octo");
    expect(JSON.stringify(resultToDict(okAnsi))).not.toMatch(/gho_shouldneverappear/);

    const jsonCode = githubAuthModesMain({
      githubAuthMode: "host-gh",
      repo: TARGET_REPO,
      json: true,
      runGh: stubGh({
        authCode: 1,
        user: { code: 1, stdout: tokenOut, stderr: tokenOut },
      }),
    });
    expect(jsonCode).toBe(1);
  });

  it("validateGithubAuthForWorker infers mode and resultToDict/cli emit (#3027)", () => {
    const worker = validateGithubAuthForWorker("host-gh", {
      repo: TARGET_REPO,
      runGh: () => proc(1, "", "auth"),
    });
    expect(worker.ok).toBe(false);
    expect(worker.failureKind).toBe(FAILURE_API_UNREACHABLE);

    const dict = resultToDict(worker);
    expect(dict.ok).toBe(false);
    expect(dict.github_auth_mode).toBe("host-gh");
    expect(dict.failure_kind).toBe(FAILURE_API_UNREACHABLE);

    const missing = validateGithubAuth("injected-token", {
      environ: {},
      runGh: stubGh({}),
    });
    expect(missing.ok).toBe(false);
    expect(missing.failureKind).toBe(FAILURE_MISSING_INJECTED_TOKEN);

    const exitHost = githubAuthModesMain({
      githubAuthMode: "host-gh",
      repo: TARGET_REPO,
      json: false,
      runGh: stubGh({ user: { code: 0, stdout: '{"login":"h"}' } }),
    });
    expect(exitHost).toBe(0);

    const exitJson = githubAuthModesMain({
      githubAuthMode: "host-gh",
      repo: TARGET_REPO,
      json: true,
      runGh: () => proc(1, "", "auth"),
    });
    expect(exitJson).toBe(1);
  });

  it("does not infer injected mode from runtime and prints remediation on CLI fail (#3027 / #5016)", () => {
    expect(inferGithubAuthMode({})).toBe("host-gh");

    const failRemediation = validateHostGhMode(
      {},
      {
        repo: TARGET_REPO,
        runtimeMode: RUNTIME_MODE_CURSOR_NATIVE_SANDBOX,
        runGh: () => proc(1, "", "auth"),
      },
    );
    expect(failRemediation.remediation).toMatch(/sandbox/i);

    const code = githubAuthModesMain({
      githubAuthMode: "host-gh",
      repo: TARGET_REPO,
      json: false,
      runGh: () => proc(1, "", "nope"),
    });
    expect(code).toBe(1);

    const inferred = validateGithubAuthForWorker(null, {
      environ: {},
      runtimeReport: {
        runtimeMode: RUNTIME_MODE_CLOUD_HEADLESS,
      } as never,
      runGh: () => proc(1, "", "x"),
    });
    expect(inferred.githubAuthMode).toBe("host-gh");
  });
});

describe("expected GitHub worker principal (#3665)", () => {
  it("parses owner/repo from slugs and remotes", () => {
    expect(parseOwnerRepoSlug("acme/widgets")).toBe("acme/widgets");
    expect(parseOwnerRepoSlug("https://github.com/acme/widgets.git")).toBe("acme/widgets");
    expect(parseOwnerRepoSlug("git@github.com:acme/widgets.git")).toBe("acme/widgets");
    expect(parseOwnerRepoSlug("git@github.example.com:acme/widgets.git")).toBe("acme/widgets");
    expect(parseOwnerRepoSlug("not-a-slug")).toBeNull();
  });

  it("derives the target repo from GH_REPO rather than a public default", () => {
    const derived = deriveValidationRepo({
      environ: { GH_REPO: "acme/widgets" },
      readGitRemote: () => "https://github.com/deftai/directive.git",
    });
    expect(derived).toEqual({ ok: true, repo: "acme/widgets" });
  });

  it("fails closed when no target repo can be derived", () => {
    const isolated = validateHostGhMode(
      {},
      {
        runGh: stubGh({}),
        readGitRemote: () => null,
      },
    );
    expect(isolated.ok).toBe(false);
    expect(isolated.failureKind).toBe(FAILURE_MISSING_TARGET_REPO);
    expect(isolated.detail).not.toMatch(/deftai\/directive/);
  });

  it("compares /user login against an expected user principal", () => {
    const match = validateHostGhMode(
      {},
      {
        repo: TARGET_REPO,
        expectedPrincipal: USER_PRINCIPAL,
        runGh: stubGh({}),
      },
    );
    expect(match.ok).toBe(true);
    expect(match.login).toBe("octo");
    expect(match.principal).toEqual({ kind: PRINCIPAL_KIND_USER, login: "octo" });

    const mismatch = validateHostGhMode(
      {},
      {
        repo: TARGET_REPO,
        expectedPrincipal: { kind: PRINCIPAL_KIND_USER, login: "maintainer" },
        runGh: stubGh({}),
      },
    );
    expect(mismatch.ok).toBe(false);
    expect(mismatch.failureKind).toBe(FAILURE_PRINCIPAL_MISMATCH);
    expect(mismatch.login).toBe("octo");
    expect(mismatch.detail).toMatch(/identity mismatch/);
  });

  it("fails closed on an installation credential even with an expected user login", () => {
    const result = validateInjectedTokenMode(
      { GH_TOKEN: "present-not-captured" },
      {
        repo: TARGET_REPO,
        expectedPrincipal: USER_PRINCIPAL,
        runGh: stubGh({ user: INSTALLATION_USER_403 }),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe(FAILURE_INSTALLATION_IDENTITY_UNVERIFIABLE);
    expect(result.detail).toMatch(/inapplicable/i);
    expect(result.detail).toContain(INSTALLATION_IDENTITY_ISSUE_URL);
    expect(result.detail).not.toMatch(/unreachable/i);
    expect(JSON.stringify(result)).not.toContain("present-not-captured");
  });

  it("admits unassigned installation authentication without claiming App identity", () => {
    const result = validateInjectedTokenMode(
      { GH_TOKEN: "present-not-captured" },
      {
        repo: TARGET_REPO,
        runGh: stubGh({
          user: INSTALLATION_USER_403,
          installation: { code: 0, stdout: INSTALLATION_REPOS_OK },
        }),
      },
    );
    expect(result.ok).toBe(true);
    expect(result.login).toBeNull();
    expect(result.installationAuthenticated).toBe(true);
    expect(result.detail).toMatch(/without verified user login or issuing-App identity/i);
    expect(JSON.stringify(resultToDict(result))).not.toContain("present-not-captured");
  });

  it("does not treat an installation-token /user 403 as API unreachability", () => {
    const proc403 = proc(
      1,
      '{"message":"Resource not accessible by integration","status":"403"}',
      "gh: Resource not accessible by integration (HTTP 403)",
    );
    expect(isInstallationUserEndpointInapplicable(proc403)).toBe(true);
    const detail = formatUserApiFailureDetail("host-gh", proc403);
    expect(detail).not.toMatch(/API is unreachable/);

    const result = validateHostGhMode(
      {},
      {
        repo: TARGET_REPO,
        runGh: stubGh({
          user: INSTALLATION_USER_403,
          installation: { code: 0, stdout: INSTALLATION_REPOS_OK },
        }),
      },
    );
    expect(result.ok).toBe(true);
    expect(result.installationAuthenticated).toBe(true);
    expect(result.login).toBeNull();
    expect(result.detail).not.toMatch(/API is unreachable/);
  });

  it("still reports a true unreachable detail when /user cannot be reached", () => {
    const result = validateHostGhMode(
      {},
      {
        repo: TARGET_REPO,
        runGh: stubGh({ user: { code: 1, stdout: "", stderr: "dial tcp: i/o timeout" } }),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe(FAILURE_API_UNREACHABLE);
    expect(result.detail).toMatch(/unreachable/i);
  });

  it("resolves expected user principal from env", () => {
    const result = validateHostGhMode(
      { [ENV_EXPECTED_GITHUB_LOGIN]: "octo" },
      {
        repo: TARGET_REPO,
        runGh: stubGh({}),
      },
    );
    expect(result.ok).toBe(true);
    expect(result.principal).toEqual({ kind: PRINCIPAL_KIND_USER, login: "octo" });
  });

  it("does not accept an installation credential from an App-slug env assertion", () => {
    const result = validateHostGhMode(
      { DEFT_EXPECTED_GITHUB_APP_SLUG: "deft-worker" },
      {
        repo: TARGET_REPO,
        runGh: stubGh({ user: INSTALLATION_USER_403 }),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe(FAILURE_API_UNREACHABLE);
    expect(result.installationAuthenticated).toBe(false);
  });

  it("CLI expected-login mismatch fails closed", () => {
    const code = githubAuthModesMain({
      githubAuthMode: "host-gh",
      repo: TARGET_REPO,
      expectedLogin: "maintainer",
      json: true,
      runGh: stubGh({}),
    });
    expect(code).toBe(1);
  });

  it("CLI App-installation flags are deferred to #3693", () => {
    expect(githubAuthModesCliMain(["--expected-app-slug", "deft-worker"])).toBe(2);
  });
});

describe("hostStoreIdentityFingerprint (#5016)", () => {
  it("does not read the process home store from a stub env", () => {
    expect(hostStoreIdentityFingerprint({}, "github.com")).toBe("hosts:missing");
  });

  it("changes when the host-store user changes and never echoes the token", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-gh-fp-"));
    try {
      writeFileSync(
        join(dir, "hosts.yml"),
        "github.com:\n    user: alice\n    users:\n        alice:\n            oauth_token: gho_secret_alice\n",
        "utf8",
      );
      const alice = hostStoreIdentityFingerprint({ GH_CONFIG_DIR: dir }, "github.com");
      writeFileSync(
        join(dir, "hosts.yml"),
        "github.com:\n    user: bob\n    users:\n        bob:\n            oauth_token: gho_secret_bob\n",
        "utf8",
      );
      const bob = hostStoreIdentityFingerprint({ GH_CONFIG_DIR: dir }, "github.com");
      expect(alice).toMatch(/^hosts:[0-9a-f]{16}$/);
      expect(bob).toMatch(/^hosts:[0-9a-f]{16}$/);
      expect(alice).not.toBe(bob);
      expect(alice).not.toContain("gho_");
      expect(bob).not.toContain("alice");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
