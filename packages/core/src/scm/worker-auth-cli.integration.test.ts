import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ENV_WORKER_CREDENTIAL_DELIVERY_ID,
  writeWorkerAuthAssignment,
} from "../swarm/worker-auth-assignment.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ROOT = process.cwd();
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SCM_MAIN = join(ROOT, "packages/core/src/scm/main.ts");
const INGEST = join(ROOT, "packages/core/src/intake/issue-ingest-cli.ts");
const RECONCILE = join(ROOT, "packages/core/src/intake/reconcile-issues-cli.ts");

function gitInit(root: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "T"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: root });
}

function linkedPair(): { main: string; worktree: string } {
  const main = mkdtempSync(join(tmpdir(), "cli-main-"));
  temps.push(main);
  gitInit(main);
  const worktree = mkdtempSync(join(tmpdir(), "cli-wt-"));
  temps.push(worktree);
  rmSync(worktree, { recursive: true, force: true });
  execFileSync("git", ["worktree", "add", "-q", worktree, "HEAD"], { cwd: main });
  return { main, worktree };
}

function writeFakeGh(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "gh.js");
  writeFileSync(
    script,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const log = process.env.DEFT_FAKE_GH_LOG;
if (log) fs.appendFileSync(log, args.join(" ") + "\\n");
const opLog = process.env.DEFT_FAKE_GH_OPS;
const isAuth = args[0] === "auth";
const isUser = args[0] === "api" && args[1] === "user";
const isRepo = args[0] === "api" && String(args[1] ?? "").startsWith("repos/");
const isOp = args[0] === "issue" || args[0] === "api" && !isUser && !isRepo;
if (isOp && opLog) fs.appendFileSync(opLog, args.join(" ") + "\\n");
if (isAuth) process.exit(Number(process.env.DEFT_FAKE_GH_AUTH_EXIT ?? "0"));
if (isUser) {
  process.stdout.write(process.env.DEFT_FAKE_GH_USER_JSON ?? '{"login":"worker-a"}');
  process.exit(Number(process.env.DEFT_FAKE_GH_USER_EXIT ?? "0"));
}
if (isRepo) {
  process.stdout.write("{}");
  process.exit(Number(process.env.DEFT_FAKE_GH_REPO_EXIT ?? "0"));
}
if (isOp && opLog) {
  /* already logged */
}
process.stdout.write("[]\\n");
process.exit(Number(process.env.DEFT_FAKE_GH_OP_EXIT ?? "0"));
`,
    "utf8",
  );
  const unix = join(dir, "gh");
  writeFileSync(unix, `#!/usr/bin/env node\nrequire("./gh.js");\n`, "utf8");
  chmodSync(unix, 0o755);
  writeFileSync(join(dir, "gh.cmd"), `@echo off\r\nnode "%~dp0gh.js" %*\r\n`, "utf8");
}

function writeRunner(dir: string, specifier: string, exportName: string): string {
  const runner = join(dir, "run.ts");
  writeFileSync(
    runner,
    `import { ${exportName} } from ${JSON.stringify(specifier)};
const fn = ${exportName};
const code = fn(process.argv.slice(2));
process.exit(typeof code === "number" ? code : 0);
`,
    "utf8",
  );
  return runner;
}

function runWorkerCli(options: {
  worktree: string;
  fakeGh: string;
  log: string;
  ops: string;
  runner: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}): { status: number | null; stderr: string; stdout: string } {
  const pathSep = process.platform === "win32" ? ";" : ":";
  const result = spawnSync(process.execPath, [TSX, options.runner, ...options.args], {
    cwd: options.worktree,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${options.fakeGh}${pathSep}${process.env.PATH ?? ""}`,
      DEFT_FAKE_GH_LOG: options.log,
      DEFT_FAKE_GH_OPS: options.ops,
      DEFT_SCM_SKIP_AUTH_PROBE: "",
      VITEST: "true",
      CI: "",
      GITHUB_ACTIONS: "",
      GROK_BUILD: "",
      CURSOR_AGENT: "",
      DEFT_GITHUB_AUTH_MODE: options.env?.DEFT_GITHUB_AUTH_MODE,
      GH_TOKEN: options.env?.GH_TOKEN,
      GITHUB_TOKEN: options.env?.GITHUB_TOKEN,
      GH_ENTERPRISE_TOKEN: options.env?.GH_ENTERPRISE_TOKEN,
      [ENV_WORKER_CREDENTIAL_DELIVERY_ID]: options.env?.[ENV_WORKER_CREDENTIAL_DELIVERY_ID],
      GH_REPO: "acme/widgets",
      ...options.env,
    },
  });
  return { status: result.status, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
}

describe("registered worker CLI entry points (#3663)", { timeout: 30_000 }, () => {
  it("T1: each named CLI exits 2 and never calls the repository operation when worker auth fails", () => {
    const { main, worktree } = linkedPair();
    expect(
      writeWorkerAuthAssignment({
        projectRoot: main,
        worktreePath: worktree,
        dispatchId: "dispatch-1",
        storyId: "story-a",
        githubAuthMode: "host-gh",
        expectedPrincipal: { kind: "user", login: "worker-a" },
        credentialDeliveryId: null,
      }).ok,
    ).toBe(true);

    const fakeGh = mkdtempSync(join(tmpdir(), "fake-gh-"));
    temps.push(fakeGh);
    writeFakeGh(fakeGh);
    const log = join(fakeGh, "calls.log");
    const ops = join(fakeGh, "ops.log");
    writeFileSync(log, "");
    writeFileSync(ops, "");

    const cases: Array<{ specifier: string; exportName: string; args: string[] }> = [
      {
        specifier: SCM_MAIN,
        exportName: "main",
        args: ["issue", "list", "--repo", "acme/widgets"],
      },
      {
        specifier: INGEST,
        exportName: "mainEntry",
        args: ["1", "--repo", "acme/widgets", "--dry-run"],
      },
      {
        specifier: RECONCILE,
        exportName: "mainEntry",
        args: ["--repo", "acme/widgets", "--vbrief-dir", worktree],
      },
    ];

    for (const cli of cases) {
      writeFileSync(log, "");
      writeFileSync(ops, "");
      const runner = writeRunner(fakeGh, cli.specifier, cli.exportName);
      const result = runWorkerCli({
        worktree,
        fakeGh,
        log,
        ops,
        runner,
        args: cli.args,
        env: { DEFT_FAKE_GH_AUTH_EXIT: "1" },
      });
      expect(result.status, `${cli.exportName} stderr=${result.stderr}`).toBe(2);
      expect(result.stderr).toMatch(
        /SCM not ready|gh auth status failed|worker auth failed|unauthenticated/i,
      );
      expect(readFileSync(ops, "utf8").trim()).toBe("");
    }

    const scmSource = readFileSync(SCM_MAIN, "utf8");
    const ingestSource = readFileSync(INGEST, "utf8");
    const reconcileSource = readFileSync(RECONCILE, "utf8");
    expect(scmSource).toMatch(/requireScmReady/);
    expect(ingestSource).toMatch(/requireScmReady/);
    expect(reconcileSource).toMatch(/requireScmReady/);
  });

  it("T4: assigned host-gh with an ambient token refuses before the operation", () => {
    const { main, worktree } = linkedPair();
    writeWorkerAuthAssignment({
      projectRoot: main,
      worktreePath: worktree,
      dispatchId: "dispatch-1",
      storyId: "story-a",
      githubAuthMode: "host-gh",
      expectedPrincipal: { kind: "user", login: "worker-a" },
      credentialDeliveryId: null,
    });
    const fakeGh = mkdtempSync(join(tmpdir(), "fake-gh-"));
    temps.push(fakeGh);
    writeFakeGh(fakeGh);
    const log = join(fakeGh, "calls.log");
    const ops = join(fakeGh, "ops.log");
    writeFileSync(log, "");
    writeFileSync(ops, "");
    const runner = writeRunner(fakeGh, SCM_MAIN, "main");
    for (const tokenVar of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"] as const) {
      writeFileSync(ops, "");
      const result = runWorkerCli({
        worktree,
        fakeGh,
        log,
        ops,
        runner,
        args: ["issue", "list", "--repo", "acme/widgets"],
        env: { [tokenVar]: "gho_not_a_real_token", DEFT_FAKE_GH_AUTH_EXIT: "0" },
      });
      expect(result.status, tokenVar).toBe(2);
      expect(result.stderr).toMatch(/ambient_token_conflict|GH_TOKEN/);
      expect(readFileSync(ops, "utf8").trim()).toBe("");
    }
  });

  it("T2: omitted delivery id refuses injected-token workers", () => {
    const { main, worktree } = linkedPair();
    writeWorkerAuthAssignment({
      projectRoot: main,
      worktreePath: worktree,
      dispatchId: "dispatch-1",
      storyId: "story-a",
      githubAuthMode: "injected-token",
      expectedPrincipal: { kind: "user", login: "worker-a" },
      credentialDeliveryId: "delivery-expected",
    });
    const fakeGh = mkdtempSync(join(tmpdir(), "fake-gh-"));
    temps.push(fakeGh);
    writeFakeGh(fakeGh);
    const log = join(fakeGh, "calls.log");
    const ops = join(fakeGh, "ops.log");
    writeFileSync(log, "");
    writeFileSync(ops, "");
    const runner = writeRunner(fakeGh, SCM_MAIN, "main");
    const result = runWorkerCli({
      worktree,
      fakeGh,
      log,
      ops,
      runner,
      args: ["issue", "list", "--repo", "acme/widgets"],
      env: { GH_TOKEN: "gho_not_a_real_token", DEFT_FAKE_GH_AUTH_EXIT: "0" },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/missing_delivery|DEFT_WORKER_CREDENTIAL_DELIVERY_ID/);
    expect(readFileSync(ops, "utf8").trim()).toBe("");
  });

  it("T5: inherited DEFT_GITHUB_AUTH_MODE does not admit host-gh on an ambiguous runtime", () => {
    const { main, worktree } = linkedPair();
    writeWorkerAuthAssignment({
      projectRoot: main,
      worktreePath: worktree,
      dispatchId: "dispatch-1",
      storyId: "story-a",
      githubAuthMode: "host-gh",
      expectedPrincipal: { kind: "user", login: "worker-a" },
      credentialDeliveryId: null,
    });
    const fakeGh = mkdtempSync(join(tmpdir(), "fake-gh-"));
    temps.push(fakeGh);
    writeFakeGh(fakeGh);
    const log = join(fakeGh, "calls.log");
    const ops = join(fakeGh, "ops.log");
    writeFileSync(log, "");
    writeFileSync(ops, "");
    const runner = writeRunner(fakeGh, SCM_MAIN, "main");
    const result = runWorkerCli({
      worktree,
      fakeGh,
      log,
      ops,
      runner,
      args: ["issue", "list", "--repo", "acme/widgets"],
      env: { CURSOR_AGENT: "1", DEFT_GITHUB_AUTH_MODE: "host-gh", DEFT_FAKE_GH_AUTH_EXIT: "0" },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/runtime_mode_denied|host-gh is not admitted/);
    expect(readFileSync(ops, "utf8").trim()).toBe("");
  });
});
