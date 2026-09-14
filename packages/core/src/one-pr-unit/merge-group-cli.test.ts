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
