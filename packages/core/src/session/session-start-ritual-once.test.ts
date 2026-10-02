import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EnvironmentContext } from "../platform/shell-context.js";
import { parseRunSummaryJsonl } from "../run-summary/share.js";
import { ENV_RUN_SUMMARY_PATH } from "../run-summary/types.js";
import type { GitRunResult } from "./git.js";
import {
  applyWorktreeOccupancy,
  OCCUPANCY_TTL_MS,
  readOccupancy,
  stealOccupancy,
} from "./occupancy.js";
import { markRitualStaleAfterCompact } from "./ritual-sentinel.js";
import {
  resolveSessionStartTrigger,
  runSessionStart,
  type SessionStartOptions,
} from "./session-start.js";

const temps: string[] = [];
const environment: EnvironmentContext = {
  hostPlatform: "darwin",
  shell: { name: "zsh", path: "/bin/zsh", kind: "default", source: "SHELL" },
};

afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "session-start-ritual-once-"));
  temps.push(root);
  return root;
}

function fakeGit(root: string): (root: string, args: readonly string[]) => GitRunResult {
  return (_root, args) => {
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") {
      return { code: 1, stdout: "", stderr: "" };
    }
    if (args[0] === "rev-parse" && args.includes("HEAD")) {
      return { code: 0, stdout: "deadbeef", stderr: "" };
    }
    if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
      return { code: 0, stdout: root, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "" };
  };
}

function emptyFinalizeOwedProbe() {
  return { lines: [] as const, blocks: false, unknown: false };
}

function baseOptions(root: string, out: string): SessionStartOptions {
  return {
    writeHistory: false,
    runGit: fakeGit(root),
    verifyTools: () => ({ exitCode: 0 }),
    runTriageWelcome: () => ({ exitCode: 0 }),
    probeEnvironment: () => environment,
    probeScm: () => ({
      ready: true,
      binary: "gh",
      binaryPath: "/usr/bin/gh",
      authState: "authenticated",
      githubAuthMode: "host-gh",
      runtimeMode: "local-unsandboxed",
      injectedTokenPresent: false,
      depth: "shallow",
      detail: "SCM ready: gh present, host-gh authenticated (shallow)",
      remediation: null,
      skippedGates: [],
      login: null,
      failureKind: null,
    }),
    probeFinalizeOwed: emptyFinalizeOwedProbe,
    runStalenessTickler: () => ({ lines: [], prompted: false }),
    env: { [ENV_RUN_SUMMARY_PATH]: out },
  };
}

function sessionStarts(out: string): Array<{
  session_id: string;
  trigger: string | undefined;
}> {
  if (!existsSync(out)) return [];
  return parseRunSummaryJsonl(readFileSync(out, "utf8"))
    .filter((e) => e.event === "session_start")
    .map((e) => ({
      session_id: e.session_id,
      trigger: (e.payload as { trigger?: string }).trigger,
    }));
}

function coldStarts(out: string): Array<{ session_id: string; trigger: string | undefined }> {
  return sessionStarts(out).filter((e) => e.trigger === "cold");
}

describe("resolveSessionStartTrigger (#3921)", () => {
  it("maps occupancy and prior ritual onto the closed trigger set", () => {
    expect(resolveSessionStartTrigger({ occupancyAction: "stolen" })).toBe("steal-recover");
    expect(
      resolveSessionStartTrigger({
        occupancyAction: "heartbeat",
        sessionId: "s",
        priorRitual: {
          sessionId: "s",
          raw: { compact_resume_at: "2026-08-17T12:00:00Z", session_id: "s" },
        } as never,
      }),
    ).toBe("post-compact");
    expect(
      resolveSessionStartTrigger({
        occupancyAction: "heartbeat",
        sessionId: "s",
        priorRitual: { raw: {}, sessionId: "s" } as never,
      }),
    ).toBe("mutation-intent");
    expect(
      resolveSessionStartTrigger({
        occupancyAction: "claimed",
        sessionId: "s",
        priorRitual: { sessionId: "s", raw: { rearm_needed: true, session_id: "s" } } as never,
      }),
    ).toBe("rearm-forced-cold");
    expect(resolveSessionStartTrigger({ occupancyAction: "claimed" })).toBe("cold");
    expect(
      resolveSessionStartTrigger({
        occupancyAction: "heartbeat",
      }),
    ).toBe("cold");
  });

  it("keeps steal-recover first even when a foreign compact marker remains", () => {
    expect(
      resolveSessionStartTrigger({
        occupancyAction: "stolen",
        sessionId: "stealer",
        priorRitual: {
          sessionId: "old-owner",
          raw: { compact_resume_at: "2026-08-17T12:00:00Z", session_id: "old-owner" },
        } as never,
      }),
    ).toBe("steal-recover");
  });

  it("does not inherit compact or rearm markers from a foreign or missing prior session id", () => {
    expect(
      resolveSessionStartTrigger({
        occupancyAction: "claimed",
        sessionId: "new-claimant",
        priorRitual: {
          sessionId: "old-owner",
          raw: { compact_resume_at: "2026-08-17T12:00:00Z", session_id: "old-owner" },
        } as never,
      }),
    ).toBe("cold");
    expect(
      resolveSessionStartTrigger({
        occupancyAction: "claimed",
        sessionId: "new-claimant",
        priorRitual: { raw: { compact_resume_at: "2026-08-17T12:00:00Z" } } as never,
      }),
    ).toBe("cold");
    expect(
      resolveSessionStartTrigger({
        occupancyAction: "claimed",
        sessionId: "new-claimant",
        priorRitual: { sessionId: "old-owner", raw: { rearm_needed: true } } as never,
      }),
    ).toBe("cold");
  });
});

describe("one cold session_start JSONL event per host session (#3921)", () => {
  it("emits one cold session_start under compact (thin) prompt shape", () => {
    const root = tempRoot();
    const out = join(root, "summary.jsonl");
    const sessionId = "thin-host";
    const first = runSessionStart(root, {
      ...baseOptions(root, out),
      sessionId,
      compact: true,
    });
    expect(first.code).toBe(0);
    const second = runSessionStart(root, {
      ...baseOptions(root, out),
      sessionId,
      compact: true,
    });
    expect(second.code).toBe(0);
    const starts = sessionStarts(out).filter((e) => e.session_id === sessionId);
    expect(starts).toHaveLength(2);
    expect(coldStarts(out).filter((e) => e.session_id === sessionId)).toHaveLength(1);
    expect(starts[0]?.trigger).toBe("cold");
    expect(starts[1]?.trigger).toBe("mutation-intent");
  });

  it("emits one cold session_start under verbose (heavyweight) prompt shape", () => {
    const root = tempRoot();
    const out = join(root, "summary.jsonl");
    const sessionId = "heavy-host";
    const first = runSessionStart(root, {
      ...baseOptions(root, out),
      sessionId,
    });
    expect(first.code).toBe(0);
    const second = runSessionStart(root, {
      ...baseOptions(root, out),
      sessionId,
    });
    expect(second.code).toBe(0);
    const starts = sessionStarts(out).filter((e) => e.session_id === sessionId);
    expect(starts).toHaveLength(2);
    expect(coldStarts(out).filter((e) => e.session_id === sessionId)).toHaveLength(1);
    expect(starts[0]?.trigger).toBe("cold");
    expect(starts[1]?.trigger).toBe("mutation-intent");
  });

  it("documents post-compact as the trigger on a second cold emit after compact resume", () => {
    const root = tempRoot();
    const out = join(root, "summary.jsonl");
    const sessionId = "compact-host";
    expect(
      runSessionStart(root, {
        ...baseOptions(root, out),
        sessionId,
      }).code,
    ).toBe(0);
    const marked = markRitualStaleAfterCompact(root, {
      now: new Date("2026-08-17T13:00:00Z"),
    });
    expect(marked.changed).toBe(true);
    expect(
      runSessionStart(root, {
        ...baseOptions(root, out),
        sessionId,
      }).code,
    ).toBe(0);
    const starts = sessionStarts(out).filter((e) => e.session_id === sessionId);
    expect(starts.map((e) => e.trigger)).toEqual(["cold", "post-compact"]);
    expect(coldStarts(out).filter((e) => e.session_id === sessionId)).toHaveLength(1);
  });

  it("emits cold for a new claimant after the prior occupant's compact marker and lease expire", () => {
    const root = tempRoot();
    const out = join(root, "summary.jsonl");
    const t0 = new Date("2026-08-17T12:00:00Z");
    expect(
      runSessionStart(root, {
        ...baseOptions(root, out),
        sessionId: "old-owner",
        now: t0,
      }).code,
    ).toBe(0);
    const marked = markRitualStaleAfterCompact(root, {
      now: new Date("2026-08-17T12:05:00Z"),
    });
    expect(marked.changed).toBe(true);
    const later = new Date(t0.getTime() + OCCUPANCY_TTL_MS + 1);
    expect(
      runSessionStart(root, {
        ...baseOptions(root, out),
        sessionId: "new-claimant",
        now: later,
      }).code,
    ).toBe(0);
    expect(
      sessionStarts(out)
        .filter((e) => e.session_id === "old-owner")
        .map((e) => e.trigger),
    ).toEqual(["cold"]);
    expect(
      sessionStarts(out)
        .filter((e) => e.session_id === "new-claimant")
        .map((e) => e.trigger),
    ).toEqual(["cold"]);
  });
});

describe("steal-recover does not mint a second cold session_id (#3921)", () => {
  it("refuses session:start --steal when the writer identity would be minted", () => {
    const root = tempRoot();
    const out = join(root, "summary.jsonl");
    mkdirSync(join(root, ".deft"), { recursive: true });
    applyWorktreeOccupancy(root, {
      sessionId: "old-owner",
      now: new Date("2026-08-17T12:00:00Z"),
    });
    const denied = runSessionStart(root, {
      ...baseOptions(root, out),
      steal: true,
      confirm: true,
      occupant: "old-owner",
      newSessionId: () => "minted-stealer",
    });
    expect(denied.code).toBe(1);
    expect(denied.lines.join("\n")).toContain("refuses to mint a writer identity");
    expect(sessionStarts(out)).toEqual([]);
    expect(readOccupancy(root)?.sessionId).toBe("old-owner");
  });

  it("stealOccupancy without a presented id does not emit a session_start", () => {
    const root = tempRoot();
    applyWorktreeOccupancy(root, {
      sessionId: "old-owner",
      now: new Date("2026-08-17T12:00:00Z"),
    });
    const stolen = stealOccupancy(root, {
      occupant: "old-owner",
      confirm: true,
      now: new Date("2026-08-17T12:01:00Z"),
      newSessionId: () => "minted-stealer",
      env: {},
    });
    expect(stolen.code).toBe(1);
    expect(stolen.action).toBe("denied");
  });

  it("session:start --steal with a presented id emits steal-recover, not a second cold", () => {
    const root = tempRoot();
    const out = join(root, "summary.jsonl");
    applyWorktreeOccupancy(root, {
      sessionId: "old-owner",
      now: new Date("2026-08-17T12:00:00Z"),
    });
    const stolen = runSessionStart(root, {
      ...baseOptions(root, out),
      sessionId: "stealer",
      steal: true,
      confirm: true,
      occupant: "old-owner",
    });
    expect(stolen.code).toBe(0);
    const next = runSessionStart(root, {
      ...baseOptions(root, out),
      sessionId: "stealer",
    });
    expect(next.code).toBe(0);
    const starts = sessionStarts(out).filter((e) => e.session_id === "stealer");
    expect(starts.map((e) => e.trigger)).toEqual(["steal-recover", "mutation-intent"]);
    expect(coldStarts(out).filter((e) => e.session_id === "stealer")).toHaveLength(0);
    expect(sessionStarts(out).some((e) => e.session_id === "minted-stealer")).toBe(false);
  });

  it("steal then first ceremony as the stealer emits one cold session_start", () => {
    const root = tempRoot();
    const out = join(root, "summary.jsonl");
    applyWorktreeOccupancy(root, {
      sessionId: "old-owner",
      now: new Date("2026-08-17T12:00:00Z"),
    });
    const stolen = stealOccupancy(root, {
      sessionId: "stealer",
      occupant: "old-owner",
      confirm: true,
      now: new Date("2026-08-17T12:01:00Z"),
    });
    expect(stolen.code).toBe(0);
    const first = runSessionStart(root, {
      ...baseOptions(root, out),
      sessionId: "stealer",
    });
    expect(first.code).toBe(0);
    const second = runSessionStart(root, {
      ...baseOptions(root, out),
      sessionId: "stealer",
    });
    expect(second.code).toBe(0);
    const starts = sessionStarts(out).filter((e) => e.session_id === "stealer");
    expect(starts.map((e) => e.trigger)).toEqual(["cold", "mutation-intent"]);
    expect(coldStarts(out).filter((e) => e.session_id === "stealer")).toHaveLength(1);
  });
});
