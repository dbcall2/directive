import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Child, UmbrellaClient } from "./types.js";
import {
  buildChildIndex,
  classifyPassType,
  computeChildren,
  computeWaves,
  parseCurrentShape,
  reconcileUmbrellas,
  renderBody,
  renderUmbrellasReport,
} from "./umbrellas.js";

class FakeUmbrellaClient implements UmbrellaClient {
  comments = new Map<string, Array<{ id: number; body: string }>>();
  issues = new Map<string, { state: string; body: string }>();
  private nextId = 1000;

  private key(repo: string, issueNumber: number): string {
    return `${repo}:${issueNumber}`;
  }

  fetchIssue(repo: string, issueNumber: number): { state: string; body: string } | null {
    return this.issues.get(this.key(repo, issueNumber)) ?? null;
  }

  fetchComments(repo: string, issueNumber: number): Array<{ id: number; body: string }> {
    return [...(this.comments.get(this.key(repo, issueNumber)) ?? [])];
  }

  editIssueBody(repo: string, issueNumber: number, body: string): void {
    const key = this.key(repo, issueNumber);
    const issue = this.issues.get(key) ?? { state: "open", body: "" };
    this.issues.set(key, { ...issue, body });
  }

  editComment(_repo: string, commentId: number, body: string): void {
    for (const bucket of this.comments.values()) {
      for (const c of bucket) {
        if (c.id === commentId) c.body = body;
      }
    }
  }

  createComment(repo: string, issueNumber: number, body: string): number {
    const key = this.key(repo, issueNumber);
    const id = this.nextId++;
    const bucket = this.comments.get(key) ?? [];
    bucket.push({ id, body });
    this.comments.set(key, bucket);
    return id;
  }
}

const child = (id: string, folder = "active", deps: string[] = []): Child => ({
  story_id: id,
  title: id,
  kind: "story",
  folder,
  depends_on: deps,
});

describe("computeWaves", () => {
  it("layers dependencies", () => {
    const waves = computeWaves([child("b", "active", ["a"]), child("a")]);
    expect(waves[0]).toEqual(["a"]);
    expect(waves[1]).toEqual(["b"]);
  });

  it("handles cycle as trailing wave", () => {
    const waves = computeWaves([child("a", "active", ["b"]), child("b", "active", ["a"])]);
    expect(waves.length).toBe(1);
  });
});

describe("parseCurrentShape", () => {
  it("parses pass number", () => {
    const body = "## Current shape (as of pass-3)\n\nChild-count history: pass-1: 2, pass-2: 3\n";
    expect(parseCurrentShape(body).passN).toBe(3);
  });

  it("tolerates missing header", () => {
    expect(parseCurrentShape("no header").passN).toBeNull();
  });

  // ReDoS-hardening regression fixtures (#1782 s4 / CodeQL js/polynomial-redos):
  // the `\s*(\S.*|)$` rewrite of HISTORY_RE / LAST_UPDATED_RE / LAST_PASS_TYPE_RE
  // must stay byte-identical to the prior `\s*(.*)$` across these edge inputs.
  it("parses fields at end-of-string with no trailing newline", () => {
    const body =
      "## Current shape (as of pass-2)\n" +
      "Last updated: 2026-06-19T00:00:00Z\n" +
      "Last pass type: additive\n" +
      "Child-count history: pass-1: 1, pass-2: 2";
    const parsed = parseCurrentShape(body);
    expect(parsed.passN).toBe(2);
    expect(parsed.lastUpdated).toBe("2026-06-19T00:00:00Z");
    expect(parsed.lastPassType).toBe("additive");
    expect(parsed.history).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  it("strips surrounding whitespace identically to the trim-based parse", () => {
    const body =
      "## Current shape (as of pass-1)\n" +
      "Last updated:    2026-06-19T00:00:00Z   \n" +
      "Last pass type:\tverify\t\n" +
      "Child-count history:   pass-1: 5  \n";
    const parsed = parseCurrentShape(body);
    expect(parsed.lastUpdated).toBe("2026-06-19T00:00:00Z");
    expect(parsed.lastPassType).toBe("verify");
    expect(parsed.history).toEqual([[1, 5]]);
  });

  it("returns empty string (not null) for an all-whitespace field tail at end-of-string", () => {
    // Mirrors the frozen Python oracle: `\s*` (which includes newlines) only
    // collapses to an empty capture when no non-whitespace follows, i.e. when
    // the field sits at the very end of the body. Verified against
    // vbrief_reconcile_umbrellas.parse_current_shape.
    const body =
      "## Current shape (as of pass-2)\n" +
      "Last pass type: additive\n" +
      "Child-count history: pass-1: 1\n" +
      "Last updated:     ";
    const parsed = parseCurrentShape(body);
    expect(parsed.lastUpdated).toBe("");
    expect(parsed.lastPassType).toBe("additive");
    expect(parsed.history).toEqual([[1, 1]]);
  });

  it("captures across a whitespace run that spans newlines (Python \\s* semantics)", () => {
    // `\s*` consumes the trailing spaces AND the newline, so the capture is the
    // next non-whitespace line's content -- identical to the old `\s*(.*)$` and
    // to the Python oracle. The rewrite preserves this cross-newline behavior.
    const body = "## Current shape (as of pass-1)\nLast updated:      \nLast pass type: additive\n";
    const parsed = parseCurrentShape(body);
    expect(parsed.lastUpdated).toBe("Last pass type: additive");
  });

  it("stays linear on many-repetition whitespace input", () => {
    const spaces = " ".repeat(50000);
    const body =
      "## Current shape (as of pass-1)\n" +
      `Last updated:${spaces}2026-06-19T00:00:00Z\n` +
      `Last pass type:${spaces}refactor\n` +
      `Child-count history:${spaces}pass-1: 1\n`;
    const start = Date.now();
    const parsed = parseCurrentShape(body);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(parsed.lastUpdated).toBe("2026-06-19T00:00:00Z");
    expect(parsed.lastPassType).toBe("refactor");
    expect(parsed.history).toEqual([[1, 1]]);
  });
});

describe("classifyPassType", () => {
  it("classifies additive", () => {
    expect(classifyPassType(2, 3)).toBe("additive");
  });
});

describe("renderBody", () => {
  it("renders canonical sections", () => {
    const body = renderBody({
      passN: 1,
      lastPassType: "additive",
      lastUpdated: "2026-06-14T20:00:00Z",
      openChildren: [child("a")],
      closedChildren: [],
      waves: [["a"]],
      history: [[1, 1]],
    });
    expect(body).toContain("## Current shape (as of pass-1)");
    expect(body).toContain("### Open children");
  });
});

describe("renderUmbrellasReport", () => {
  it("prints checklist actions for changed and unchanged umbrellas", () => {
    const report = renderUmbrellasReport({
      changed: [
        {
          story_id: "epic-a\nescaped",
          repo: "deftai/directive\r\nextra",
          issue_number: 10,
          action: "edited",
          checklist_action: "unchanged",
          pass_n: 2,
          body: "body",
        },
        {
          story_id: "epic-b",
          repo: "deftai/directive",
          issue_number: 11,
          action: "created",
          checklist_action: "skipped",
          pass_n: 1,
          body: "body",
        },
      ],
      unchanged: [
        {
          story_id: "epic-c",
          repo: "deftai/directive",
          issue_number: 12,
          action: "unchanged",
          checklist_action: "edited",
          pass_n: 3,
          body: "body",
        },
      ],
      skipped_no_ref: [],
      errors: [],
      dry_run: true,
    });

    expect(report).toContain("Changed (dry-run):");
    expect(report).toContain(
      "#10 (deftai/directive extra) [epic-a escaped]: edited, checklist unchanged",
    );
    expect(report).toContain("#11 (deftai/directive) [epic-b]: created -> pass-1");
    expect(report).toContain("#12 (deftai/directive) [epic-c]: pass-3, checklist edited");
  });
});

describe("reconcileUmbrellas", () => {
  it("returns config error when no xbrief layout exists", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-umbrella-missing-layout-"));
    const [code, outcome] = reconcileUmbrellas(root, { dryRun: true });

    expect(code).toBe(2);
    expect(outcome.dry_run).toBe(true);
    expect(outcome.changed).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves github-issue children, uses forge state, and edits checklist markers", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-umbrella-issue-refs-"));
    const active = join(root, "xbrief", "active");
    const completed = join(root, "xbrief", "completed");
    mkdirSync(active, { recursive: true });
    mkdirSync(completed, { recursive: true });
    writeFileSync(
      join(active, "closed-by-issue.xbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "closed-by-issue",
          title: "Closed by issue",
          metadata: { kind: "story", swarm: { depends_on: [] } },
          references: [
            { type: "x-vbrief/github-issue", uri: "https://github.com/deftai/directive/issues/10" },
          ],
        },
      })}\n`,
    );
    writeFileSync(
      join(completed, "open-by-issue.xbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "open-by-issue",
          title: "Open by issue",
          metadata: { kind: "story", swarm: { depends_on: [] } },
          references: [
            { type: "x-vbrief/github-issue", uri: "https://github.com/deftai/directive/issues/11" },
          ],
        },
      })}\n`,
    );
    writeFileSync(
      join(active, "epic.xbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "epic-issue-refs",
          metadata: { kind: "epic", swarm: { depends_on: [] } },
          references: [
            {
              type: "x-vbrief/github-issue",
              uri: "https://github.com/deftai/directive/issues/100",
            },
            { type: "x-vbrief/github-issue", uri: "https://github.com/deftai/directive/issues/10" },
            { type: "x-vbrief/github-issue", uri: "https://github.com/deftai/directive/issues/11" },
          ],
        },
      })}\n`,
    );
    const client = new FakeUmbrellaClient();
    client.issues.set("deftai/directive:100", {
      state: "open",
      body: "- [ ] #10 closed child\n- [x] #11 reopened child\n- [ ] #999 external child\n",
    });
    client.issues.set("deftai/directive:10", { state: "closed", body: "" });
    client.issues.set("deftai/directive:11", { state: "open", body: "" });

    const [code, outcome] = reconcileUmbrellas(root, {
      client,
      now: "2026-06-14T20:00:00Z",
    });

    expect(code).toBe(0);
    expect(outcome.changed[0]?.action).toBe("created");
    expect(outcome.changed[0]?.checklist_action).toBe("edited");
    expect(outcome.changed[0]?.body).toContain("Child count: 2 (1/1)");
    expect(outcome.changed[0]?.body).toContain("- open-by-issue: Open by issue (story)");
    expect(outcome.changed[0]?.body).toContain("- closed-by-issue: Closed by issue (active)");
    expect(client.issues.get("deftai/directive:100")?.body).toBe(
      "- [x] #10 closed child\n- [ ] #11 reopened child\n- [ ] #999 external child\n",
    );
    client.issues.set("deftai/directive:100", {
      state: "open",
      body: "- [ ] #10 closed child\n- [ ] #11 reopened child\n",
    });
    const [, secondOutcome] = reconcileUmbrellas(root, {
      client,
      now: "2026-06-14T20:00:00Z",
    });
    expect(secondOutcome.changed[0]?.action).toBe("unchanged");
    expect(secondOutcome.changed[0]?.checklist_action).toBe("edited");
    expect(secondOutcome.unchanged).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("uses repo-qualified checklist state and skips stale first refs", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-umbrella-checklist-refs-"));
    const active = join(root, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "local-child.xbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "local-child",
          title: "Local child",
          metadata: { kind: "story", swarm: { depends_on: [] } },
          references: [
            { type: "x-vbrief/github-issue", uri: "https://github.com/deftai/directive/issues/42" },
          ],
        },
      })}\n`,
    );
    writeFileSync(
      join(active, "other-child.xbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "other-child",
          title: "Other child",
          metadata: { kind: "story", swarm: { depends_on: [] } },
          references: [
            { type: "x-vbrief/github-issue", uri: "https://github.com/deftai/other/issues/42" },
          ],
        },
      })}\n`,
    );
    writeFileSync(
      join(active, "epic.xbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "epic-cross-repo",
          metadata: { kind: "epic", swarm: { depends_on: [] } },
          references: [
            {
              type: "x-vbrief/github-issue",
              uri: "https://github.com/deftai/directive/issues/300",
            },
            { type: "x-vbrief/github-issue", uri: "https://github.com/deftai/directive/issues/42" },
            { type: "x-vbrief/github-issue", uri: "https://github.com/deftai/other/issues/42" },
          ],
        },
      })}\n`,
    );
    const client = new FakeUmbrellaClient();
    client.issues.set("deftai/directive:300", {
      state: "open",
      body:
        "- [ ] https://github.com/deftai/other/issues/42 other closed child\n" +
        "- [x] stale #999, tracked as #42 local open child\n",
    });
    client.issues.set("deftai/directive:42", { state: "open", body: "" });
    client.issues.set("deftai/other:42", { state: "closed", body: "" });

    const [code, outcome] = reconcileUmbrellas(root, {
      client,
      now: "2026-06-14T20:00:00Z",
    });

    expect(code).toBe(0);
    expect(outcome.changed[0]?.checklist_action).toBe("edited");
    expect(client.issues.get("deftai/directive:300")?.body).toBe(
      "- [x] https://github.com/deftai/other/issues/42 other closed child\n" +
        "- [ ] stale #999, tracked as #42 local open child\n",
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves contains edges as umbrella children", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-umbrella-edges-"));
    const active = join(root, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "edge-child.xbrief.json"),
      `${JSON.stringify({ plan: { id: "edge-child", metadata: { kind: "story", swarm: { depends_on: [] } } } })}\n`,
    );
    const index = buildChildIndex(join(root, "xbrief"));
    const children = computeChildren(
      {
        plan: {
          id: "edge-epic",
          edges: [{ from: "edge-epic", to: "edge-child", type: "contains" }],
          references: [],
        },
      },
      index,
    );
    expect(children.map((c) => c.story_id)).toEqual(["edge-child"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("creates current-shape comment", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-umbrella-"));
    const active = join(root, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "child.xbrief.json"),
      `${JSON.stringify({ plan: { id: "child-a", metadata: { kind: "story", swarm: { depends_on: [] } } } })}\n`,
    );
    writeFileSync(
      join(active, "epic.xbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "epic-1",
          metadata: { kind: "epic", swarm: { depends_on: [] } },
          references: [
            { type: "x-vbrief/plan", uri: "active/child.xbrief.json", title: "child-a" },
            {
              type: "x-vbrief/github-issue",
              uri: "https://github.com/deftai/directive/issues/1284",
            },
          ],
        },
      })}\n`,
    );
    const client = new FakeUmbrellaClient();
    const [code, outcome] = reconcileUmbrellas(root, {
      client,
      now: "2026-06-14T20:00:00Z",
    });
    expect(code).toBe(0);
    expect(outcome.changed[0]?.action).toBe("created");
    rmSync(root, { recursive: true, force: true });
  });

  it("does not write checklist edits during dry-run", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-umbrella-dry-run-"));
    const active = join(root, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "child.xbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "dry-child",
          metadata: { kind: "story", swarm: { depends_on: [] } },
          references: [
            { type: "x-vbrief/github-issue", uri: "https://github.com/deftai/directive/issues/20" },
          ],
        },
      })}\n`,
    );
    writeFileSync(
      join(active, "epic.xbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "dry-epic",
          metadata: { kind: "epic", swarm: { depends_on: [] } },
          references: [
            {
              type: "x-vbrief/github-issue",
              uri: "https://github.com/deftai/directive/issues/200",
            },
            { type: "x-vbrief/github-issue", uri: "https://github.com/deftai/directive/issues/20" },
          ],
        },
      })}\n`,
    );
    const client = new FakeUmbrellaClient();
    client.issues.set("deftai/directive:200", { state: "open", body: "- [ ] #20\n" });
    client.issues.set("deftai/directive:20", { state: "closed", body: "" });

    const [code, outcome] = reconcileUmbrellas(root, {
      client,
      dryRun: true,
      now: "2026-06-14T20:00:00Z",
    });

    expect(code).toBe(0);
    expect(outcome.changed[0]?.checklist_action).toBe("edited");
    expect(client.issues.get("deftai/directive:200")?.body).toBe("- [ ] #20\n");
    rmSync(root, { recursive: true, force: true });
  });
});
