import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadMergeGroupEventFromPath,
  main,
  runMergeGroupCheckFromEvent,
} from "./merge-group-cli.js";
import { InProcessAppStore } from "./simulator.js";

describe("merge-group CLI", () => {
  it("fails closed on missing head sha", () => {
    const result = runMergeGroupCheckFromEvent({ action: "checks_requested" });
    expect(result.conclusion).toBe("failure");
  });

  it("passes a single-origin constituent when the App store has no grant", () => {
    const store = new InProcessAppStore();
    const result = runMergeGroupCheckFromEvent(
      { action: "checks_requested", merge_group: { head_sha: "abc" } },
      {
        store,
        loadConstituents: () => [
          {
            prNodeId: "PR_1",
            repo: "deftai/directive",
            closingIssuesReferences: [4494],
            body: "Closes #4494",
            commitMessages: [],
          },
        ],
      },
    );
    expect(result.conclusion).toBe("success");
  });
});

describe("merge-group CLI entry", () => {
  it("fails closed without GITHUB_EVENT_PATH", () => {
    expect(main(["node", "merge-group-cli.js"], {})).toBe(1);
  });

  it("reads GITHUB_EVENT_PATH and fails on empty merge_group", () => {
    const dir = mkdtempSync(join(tmpdir(), "mg-"));
    const path = join(dir, "event.json");
    writeFileSync(path, '{"action":"checks_requested"}\n');
    expect(main(["node", "merge-group-cli.js"], { GITHUB_EVENT_PATH: path })).toBe(1);
  });
});

describe("production constituent loader", () => {
  it("fails closed when repository full_name is missing (no silent empty pass)", () => {
    const result = runMergeGroupCheckFromEvent({
      action: "checks_requested",
      merge_group: { head_sha: "abc" },
    });
    expect(result.conclusion).toBe("failure");
    expect(result.summary).toMatch(/missing constituent/);
  });

  it("uses loadConstituentsFromGithub when no seam override", () => {
    const store = new InProcessAppStore();
    const result = runMergeGroupCheckFromEvent(
      {
        action: "checks_requested",
        merge_group: { head_sha: "abc" },
        repository: { full_name: "deftai/directive" },
      },
      {
        store,
        runGh: (cmd) => {
          const joined = cmd.join(" ");
          if (joined.includes("/commits/abc/pulls")) {
            return {
              returncode: 0,
              stdout: JSON.stringify([{ number: 4497, node_id: "PR_1", body: "Closes #4494" }]),
              stderr: "",
            };
          }
          if (joined.includes("closingIssuesReferences")) {
            return {
              returncode: 0,
              stdout: JSON.stringify({ closingIssuesReferences: [{ number: 4494 }] }),
              stderr: "",
            };
          }
          if (joined.includes("/pulls/4497/commits")) {
            return { returncode: 0, stdout: "[]", stderr: "" };
          }
          return { returncode: 1, stdout: "", stderr: "unexpected" };
        },
      },
    );
    expect(result.conclusion).toBe("success");
  });
});
