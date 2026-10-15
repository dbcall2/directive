import { join } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { runSessionStart } from "./session-start.js";

export const SESSION_START_BARRIER_DEST_REL = join(".deft", "core", "DEST-MARKER");

export function runSessionStartOccupancyBarrier(input: {
  readonly root: string;
  readonly sessionId: string;
}): {
  readonly code: number;
  readonly destWrote: boolean;
  readonly sessionId: string;
} {
  let destWrote = false;
  const result = runSessionStart(input.root, {
    sessionId: input.sessionId,
    writeHistory: false,
    env: {},
    runGit: (_root, args) => {
      if (args[0] === "rev-parse" && args.includes("HEAD")) {
        return { code: 0, stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", stderr: "" };
      }
      if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
        return { code: 0, stdout: input.root, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    },
    verifyTools: () => ({ exitCode: 0 }),
    runTriageWelcome: () => ({ exitCode: 0 }),
    orientation: null,
    runStalenessTickler: () => ({ lines: [], prompted: false }),
    probeFinalizeOwed: () => ({ lines: [], blocks: false, unknown: false }),
    resolveUserMd: () => ({
      path: join(input.root, "USER.md"),
      rung: "workspace-local",
      found: true,
      diagnostic: "ok",
      searched: [],
    }),
    probeEnvironment: () => ({
      hostPlatform: "darwin",
      shell: { name: "zsh", path: "/bin/zsh", kind: "default", source: "SHELL" },
    }),
    probeScm: () => ({
      ready: true,
      binary: "gh",
      binaryPath: "/usr/bin/gh",
      authState: "authenticated",
      githubAuthMode: "host-gh",
      runtimeMode: "local-unsandboxed",
      runtimeModeReason: null,
      injectedTokenPresent: false,
      depth: "shallow",
      detail: "SCM ready",
      remediation: null,
      skippedGates: [],
      login: null,
      failureKind: null,
    }),
    reconstituteWorktreeDeposit: () => {
      containedWrite({
        root: input.root,
        target: SESSION_START_BARRIER_DEST_REL,
        data: `${input.sessionId}\n`,
        mode: "replace",
      });
      destWrote = true;
      return {
        status: "reconstituted" as const,
        source: "/payload",
        dest: join(input.root, ".deft", "core"),
        message: "reconstituted dest marker",
      };
    },
  });
  return { code: result.code, destWrote, sessionId: input.sessionId };
}

const invokedRoot = process.env.SESSION_START_BARRIER_ROOT ?? "";
if (invokedRoot.length > 0) {
  process.stdout.write(
    `${JSON.stringify(
      runSessionStartOccupancyBarrier({
        root: invokedRoot,
        sessionId: process.env.SESSION_START_BARRIER_SESSION ?? "",
      }),
    )}\n`,
  );
}
