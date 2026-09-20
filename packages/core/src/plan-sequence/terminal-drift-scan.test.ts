import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TIP_TERMINAL_FOLDERS } from "../lifecycle/completed-tracked-on-delivery.js";
import { detectTerminalEntryDrift } from "./terminal-drift.js";
import {
  collectTerminalLifecycleOrigins,
  TERMINAL_LIFECYCLE_FOLDERS,
} from "./terminal-drift-scan.js";
import { createPlanSequence } from "./types.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function seed(): string {
  const root = mkdtempSync(join(tmpdir(), "plan-drift-scan-"));
  roots.push(root);
  return root;
}

function writeBrief(
  root: string,
  relDir: string,
  name: string,
  plan: Record<string, unknown>,
): void {
  const dir = join(root, relDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan }));
}

describe("collectTerminalLifecycleOrigins (#4129)", () => {
  it("locks folder names to TIP_TERMINAL_FOLDERS", () => {
    expect([...TERMINAL_LIFECYCLE_FOLDERS]).toEqual([...TIP_TERMINAL_FOLDERS]);
  });

  it("scans completed xBRIEFs via collectGithubRefs and matches the current issue entry", () => {
    const root = seed();
    writeBrief(root, "xbrief/completed", "2026-09-01-287-done.xbrief.json", {
      title: "Done 287",
      status: "completed",
      id: "story-287",
      references: [
        {
          uri: "https://github.com/acme/app/issues/287",
          type: "x-xbrief/github-issue",
        },
      ],
    });
    const terminals = collectTerminalLifecycleOrigins(root, { defaultRepo: "acme/app" });
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.issueNumbers).toContain(287);
    expect(terminals[0]?.folder).toBe("completed");
    expect(terminals[0]?.storyIds).toEqual(
      expect.arrayContaining(["2026-09-01-287-done", "287-done", "story-287"]),
    );

    const seq = createPlanSequence({
      sequence_id: "s",
      sequence_kind: "delivery",
      authorized_by: "t",
      entries: [{ id: "287", kind: "issue", issue: 287 }],
    });
    expect(detectTerminalEntryDrift(seq, terminals).drifted).toBe(true);
  });

  it("scans cancelled/ and legacy vbrief/completed", () => {
    const root = seed();
    writeBrief(root, "xbrief/cancelled", "drop.xbrief.json", {
      title: "Drop",
      status: "cancelled",
      references: [{ uri: "https://github.com/acme/app/issues/9", type: "x-xbrief/github-issue" }],
    });
    writeBrief(root, "vbrief/completed", "legacy.vbrief.json", {
      title: "Legacy",
      status: "failed",
      references: [{ uri: "https://github.com/acme/app/issues/10", type: "x-xbrief/github-issue" }],
    });
    const terminals = collectTerminalLifecycleOrigins(root, { defaultRepo: "acme/app" });
    const folders = terminals.map((t) => t.folder).sort();
    expect(folders).toEqual(["cancelled", "completed"]);
    expect(terminals.some((t) => t.issueNumbers.includes(9))).toBe(true);
    expect(terminals.some((t) => t.failed && t.issueNumbers.includes(10))).toBe(true);
  });

  it("does not scan active/ as terminal evidence", () => {
    const root = seed();
    writeBrief(root, "xbrief/active", "still-running.xbrief.json", {
      title: "Running",
      status: "running",
      references: [
        { uri: "https://github.com/acme/app/issues/287", type: "x-xbrief/github-issue" },
      ],
    });
    expect(collectTerminalLifecycleOrigins(root, { defaultRepo: "acme/app" })).toEqual([]);
  });

  it("ignores unreadable JSON in terminal folders", () => {
    const root = seed();
    const dir = join(root, "xbrief/completed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken.xbrief.json"), "{not json");
    writeFileSync(join(dir, "notes.md"), "not an artifact");
    writeFileSync(join(dir, "array.xbrief.json"), "[]");
    expect(collectTerminalLifecycleOrigins(root, { defaultRepo: "acme/app" })).toEqual([]);
  });

  it("does not treat a completed umbrella mention as the current issue origin", () => {
    const root = seed();
    writeBrief(root, "xbrief/completed", "2026-09-01-3913-umbrella.xbrief.json", {
      title: "Umbrella that mentions 287",
      status: "completed",
      narratives: {
        Origin: "Ingested from https://github.com/acme/app/issues/3913",
      },
      references: [
        {
          uri: "https://github.com/acme/app/issues/3913",
          type: "x-xbrief/github-issue",
        },
        {
          uri: "https://github.com/acme/app/issues/287",
          type: "x-xbrief/refs",
        },
      ],
      metadata: { "x-tracking": { parent_issue: 287 } },
    });
    writeBrief(root, "xbrief/completed", "2026-09-01-999-sibling.xbrief.json", {
      title: "Sibling of 287",
      status: "completed",
      references: [
        {
          uri: "https://github.com/acme/app/issues/999",
          type: "x-xbrief/github-issue",
        },
        {
          uri: "https://github.com/acme/app/issues/287",
          type: "x-xbrief/github-issue",
        },
      ],
    });
    const terminals = collectTerminalLifecycleOrigins(root, { defaultRepo: "acme/app" });
    expect(terminals.some((t) => t.issueNumbers.includes(287))).toBe(false);
    expect(terminals.some((t) => t.issueNumbers.includes(3913))).toBe(true);
    expect(terminals.some((t) => t.issueNumbers.includes(999))).toBe(true);
    const seq = createPlanSequence({
      sequence_id: "s",
      sequence_kind: "delivery",
      authorized_by: "t",
      entries: [{ id: "287", kind: "issue", issue: 287 }],
    });
    expect(detectTerminalEntryDrift(seq, terminals).drifted).toBe(false);
  });

  it("falls back to the first github-issue when Origin is not a GitHub URL", () => {
    const root = seed();
    writeBrief(root, "xbrief/completed", "note-origin.xbrief.json", {
      title: "Note origin",
      status: "completed",
      narratives: { Origin: "hand-authored local story" },
      references: [
        null,
        "skip",
        {
          uri: "https://github.com/acme/app/issues/9",
          type: "x-xbrief/github-issue",
        },
      ],
    });
    const terminals = collectTerminalLifecycleOrigins(root, { defaultRepo: "acme/app" });
    expect(terminals.some((t) => t.issueNumbers.includes(9))).toBe(true);
  });

  it("keeps URI-parsed numbers when defaultRepo is empty", () => {
    const root = seed();
    writeBrief(root, "xbrief/completed", "empty-repo.xbrief.json", {
      title: "Empty default repo",
      status: "completed",
      narratives: { Origin: "" },
      references: [
        {
          uri: "https://github.com/acme/app/issues/11",
          type: "x-xbrief/github-issue",
        },
      ],
    });
    writeBrief(root, "xbrief/completed", "no-refs.xbrief.json", {
      title: "No references",
      status: "completed",
    });
    const terminals = collectTerminalLifecycleOrigins(root, { defaultRepo: "" });
    expect(terminals.some((t) => t.issueNumbers.includes(11))).toBe(true);
    expect(terminals.some((t) => t.title === "No references")).toBe(true);
  });

  it("keeps only the first github-pr as provenance origin", () => {
    const root = seed();
    writeBrief(root, "xbrief/completed", "2026-09-01-pr-99.xbrief.json", {
      title: "PR 99",
      status: "completed",
      references: [
        {
          uri: "https://github.com/acme/app/pull/99",
          type: "x-xbrief/github-pr",
        },
        {
          uri: "https://github.com/acme/app/pull/12",
          type: "x-xbrief/github-pr",
        },
      ],
    });
    const terminals = collectTerminalLifecycleOrigins(root, { defaultRepo: "acme/app" });
    expect(terminals.some((t) => t.prNumbers.includes(99))).toBe(true);
    expect(terminals.some((t) => t.prNumbers.includes(12))).toBe(false);
  });

  it("does not treat another repo's same issue number as this entry's origin", () => {
    const root = seed();
    writeBrief(root, "xbrief/completed", "2026-09-01-other-287.xbrief.json", {
      title: "Other repo 287",
      status: "completed",
      references: [
        {
          uri: "https://github.com/other/repo/issues/287",
          type: "x-xbrief/github-issue",
        },
      ],
    });
    const terminals = collectTerminalLifecycleOrigins(root, { defaultRepo: "acme/app" });
    expect(terminals.some((t) => t.issueNumbers.includes(287))).toBe(false);
    const seq = createPlanSequence({
      sequence_id: "s",
      sequence_kind: "delivery",
      authorized_by: "t",
      entries: [{ id: "287", kind: "issue", issue: 287 }],
    });
    expect(detectTerminalEntryDrift(seq, terminals).drifted).toBe(false);
  });
});
