import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyCommand,
  evaluateCommand,
  runSelfTest,
  SELF_TEST_CASES,
  tokensFromString,
} from "./classifier.js";

describe("tokensFromString", () => {
  it("splits simple space-separated tokens", () => {
    expect(tokensFromString("gh repo delete owner/repo")).toEqual([
      "gh",
      "repo",
      "delete",
      "owner/repo",
    ]);
  });

  it("handles single-quoted strings", () => {
    expect(tokensFromString("gh pr create --title 'My PR'")).toEqual([
      "gh",
      "pr",
      "create",
      "--title",
      "My PR",
    ]);
  });

  it("handles double-quoted strings", () => {
    expect(tokensFromString('git commit -m "fix: something"')).toEqual([
      "git",
      "commit",
      "-m",
      "fix: something",
    ]);
  });

  it("returns empty array for empty string", () => {
    expect(tokensFromString("")).toEqual([]);
  });
});

describe("classifyCommand -- delete_repo", () => {
  it("detects gh repo delete", () => {
    const v = classifyCommand("gh repo delete deftai/directive");
    expect(v.allowed).toBe(false);
    expect(v.category).toBe("delete_repo");
  });

  it("detects gh repo delete with flags", () => {
    const v = classifyCommand("gh repo delete deftai/directive --yes");
    expect(v.allowed).toBe(false);
    expect(v.category).toBe("delete_repo");
  });

  it("detects gh api -X DELETE repos/owner/repo", () => {
    const v = classifyCommand("gh api -X DELETE repos/deftai/directive");
    expect(v.allowed).toBe(false);
    expect(v.category).toBe("delete_repo");
  });

  it("detects gh api --method DELETE repos/owner/repo", () => {
    const v = classifyCommand("gh api --method DELETE repos/deftai/directive/contents/README.md");
    expect(v.allowed).toBe(false);
    expect(v.category).toBe("delete_repo");
  });

  it("detects -XDELETE combined short form", () => {
    const v = classifyCommand("gh api -XDELETE repos/deftai/directive");
    expect(v.allowed).toBe(false);
    expect(v.category).toBe("delete_repo");
  });

  it("allows gh api -X PATCH (non-DELETE)", () => {
    const v = classifyCommand("gh api -X PATCH repos/deftai/directive/issues/1");
    expect(v.allowed).toBe(true);
  });

  it("allows gh repo view", () => {
    const v = classifyCommand("gh repo view deftai/directive");
    expect(v.allowed).toBe(true);
  });
});

describe("classifyCommand -- admin_merge", () => {
  it("detects gh pr merge --admin", () => {
    const v = classifyCommand("gh pr merge 123 --admin");
    expect(v.allowed).toBe(false);
    expect(v.category).toBe("admin_merge");
  });

  it("detects --admin flag in any position", () => {
    const v = classifyCommand("gh pr merge --admin --squash 123");
    expect(v.allowed).toBe(false);
    expect(v.category).toBe("admin_merge");
  });

  it("allows gh pr merge without --admin", () => {
    const v = classifyCommand("gh pr merge 123 --squash");
    expect(v.allowed).toBe(true);
  });
});

describe("classifyCommand -- force_push_default", () => {
  it("detects git push --force to master", () => {
    const v = classifyCommand("git push --force origin master");
    expect(v.allowed).toBe(false);
    expect(v.category).toBe("force_push_default");
  });

  it("detects git push --force-with-lease to main", () => {
    const v = classifyCommand("git push origin --force-with-lease main");
    expect(v.allowed).toBe(false);
    expect(v.category).toBe("force_push_default");
  });

  it("detects refspec + to master", () => {
    const v = classifyCommand("git push origin +master");
    expect(v.allowed).toBe(false);
    expect(v.category).toBe("force_push_default");
  });

  it("detects git push --force HEAD:master", () => {
    const v = classifyCommand("git push --force origin HEAD:master");
    expect(v.allowed).toBe(false);
    expect(v.category).toBe("force_push_default");
  });

  it("allows git push --force to feature branch", () => {
    const v = classifyCommand("git push --force origin feat/my-branch");
    expect(v.allowed).toBe(true);
  });

  it("allows git push --force-with-lease to feature branch", () => {
    const v = classifyCommand("git push --force-with-lease origin feat/my-branch");
    expect(v.allowed).toBe(true);
  });

  it("allows plain git push (no force)", () => {
    const v = classifyCommand("git push");
    expect(v.allowed).toBe(true);
  });

  it("allows git push origin feat/my-branch", () => {
    const v = classifyCommand("git push origin feat/my-branch");
    expect(v.allowed).toBe(true);
  });
});

describe("classifyCommand -- push_default two-surface settlement", () => {
  it("refuses git push origin master", () => {
    const v = classifyCommand("git push origin master");
    expect(v.allowed).toBe(false);
    expect(v.category).toBe("push_default");
    expect(v.recovery).toContain("deft policy:allow-destructive-gh-verbs -- --confirm");
  });

  it("refuses git push -u origin master", () => {
    const v = classifyCommand("git push -u origin master");
    expect(v.allowed).toBe(false);
    expect(v.category).toBe("push_default");
  });

  it("refuses git push origin main", () => {
    const v = classifyCommand("git push origin main");
    expect(v.allowed).toBe(false);
    expect(v.category).toBe("push_default");
  });

  it("keeps force-push as force_push_default", () => {
    const v = classifyCommand("git push --force origin master");
    expect(v.category).toBe("force_push_default");
  });

  it("allows git remote add when a token is named push", () => {
    const v = classifyCommand("git remote add push master");
    expect(v.allowed).toBe(true);
  });

  it("allows git push when main is the remote and dest is a feature branch", () => {
    const v = classifyCommand("git push main my-feature");
    expect(v.allowed).toBe(true);
  });

  it("allows git push master when master is only the remote", () => {
    const v = classifyCommand("git push master");
    expect(v.allowed).toBe(true);
  });

  it("refuses git -C <path> push origin master", () => {
    const v = classifyCommand("git -C /tmp push origin master");
    expect(v.allowed).toBe(false);
    expect(v.category).toBe("push_default");
  });

  it("refuses git push --repo=origin master", () => {
    const v = classifyCommand("git push --repo=origin master");
    expect(v.allowed).toBe(false);
    expect(v.category).toBe("push_default");
  });

  it("refuses git push --repo origin master", () => {
    const v = classifyCommand("git push --repo origin master");
    expect(v.allowed).toBe(false);
    expect(v.category).toBe("push_default");
  });

  it("refuses git push --force --repo=origin master", () => {
    const v = classifyCommand("git push --force --repo=origin master");
    expect(v.allowed).toBe(false);
    expect(v.category).toBe("force_push_default");
  });

  it("refuses git push --all origin", () => {
    const v = classifyCommand("git push --all origin");
    expect(v.allowed).toBe(false);
    expect(v.category).toBe("push_default");
  });

  it("refuses git push --mirror origin", () => {
    const v = classifyCommand("git push --mirror origin");
    expect(v.allowed).toBe(false);
    expect(v.category).toBe("push_default");
  });

  it("refuses git push origin --all", () => {
    const v = classifyCommand("git push origin --all");
    expect(v.allowed).toBe(false);
    expect(v.category).toBe("push_default");
  });

  it("refuses git push --repo=origin --all", () => {
    const v = classifyCommand("git push --repo=origin --all");
    expect(v.allowed).toBe(false);
    expect(v.category).toBe("push_default");
  });

  it("allows git push --repo=origin feat/my-branch", () => {
    const v = classifyCommand("git push --repo=origin feat/my-branch");
    expect(v.allowed).toBe(true);
  });

  it("allows git push --repo=backup main feat/x when main is the remote", () => {
    const v = classifyCommand("git push --repo=backup main feat/x");
    expect(v.allowed).toBe(true);
  });
});

describe("classifyCommand -- allowed (negatives)", () => {
  it.each([
    "gh pr merge 123 --squash",
    "gh repo view deftai/directive",
    "gh api repos/deftai/directive",
    "gh api -X PATCH repos/deftai/directive/issues/1",
    "git push origin feat/my-branch",
    "git push --force origin feat/my-branch",
    "git push --force-with-lease origin feat/my-branch",
    "git push",
    "git remote add push master",
    "git push main my-feature",
    "gh pr create --title Test --body foo",
  ])("allows: %s", (cmd) => {
    const v = classifyCommand(cmd);
    expect(v.allowed).toBe(true);
  });
});

describe("runSelfTest", () => {
  it("returns exit 0 when all fixtures match", () => {
    const [code, msg] = runSelfTest();
    expect(code).toBe(0);
    expect(msg).toContain("✓");
    expect(msg).toContain(String(SELF_TEST_CASES.length));
  });

  it("reports total fixture count", () => {
    const [, msg] = runSelfTest();
    expect(msg).toContain(`${SELF_TEST_CASES.length}/${SELF_TEST_CASES.length}`);
  });

  it("returns exit 2 and reports disagreement when a fixture mismatches", () => {
    // Inject a contrived fixture: the classifier ALLOWS this command, but we
    // assert it is "delete_repo" -- forces the failure path.
    const contrived = [["gh pr merge 123 --squash", "delete_repo"]] as const;
    const [code, msg] = runSelfTest(contrived);
    expect(code).toBe(2);
    expect(msg).toContain("❌");
    expect(msg).toContain("classifier disagreement");
    expect(msg).toContain("1/1");
    expect(msg).toContain("✗");
  });

  it("accepts explicit fixture table for hermetic testing", () => {
    // All-pass with a single known-good fixture pair
    const fixture = [["gh repo delete deftai/directive", "delete_repo"]] as const;
    const [code, msg] = runSelfTest(fixture);
    expect(code).toBe(0);
    expect(msg).toContain("1/1");
  });
});

describe("classifyCommand -- ghx prefix", () => {
  it("treats ghx as a gh alias (delete_repo)", () => {
    const v = classifyCommand("ghx repo delete owner/repo");
    expect(v.allowed).toBe(false);
    expect(v.category).toBe("delete_repo");
  });
});

describe("classifyCommand -- force_push_default with refs/heads/ notation", () => {
  it("detects force-push to refs/heads/master", () => {
    const v = classifyCommand("git push --force origin HEAD:refs/heads/master");
    expect(v.allowed).toBe(false);
    expect(v.category).toBe("force_push_default");
  });
});

describe("ENV_BYPASS integration (evaluateCommand)", () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    // reset
    delete process.env.DEFT_ALLOW_DESTRUCTIVE_GH_VERBS;
  });

  afterEach(() => {
    process.env.DEFT_ALLOW_DESTRUCTIVE_GH_VERBS = OLD_ENV.DEFT_ALLOW_DESTRUCTIVE_GH_VERBS;
    if (OLD_ENV.DEFT_ALLOW_DESTRUCTIVE_GH_VERBS === undefined) {
      delete process.env.DEFT_ALLOW_DESTRUCTIVE_GH_VERBS;
    }
  });

  it("blocks destructive command when bypass is off", async () => {
    const { evaluateCommand } = await import("./classifier.js");
    const [code] = evaluateCommand("gh repo delete owner/repo");
    expect(code).toBe(1);
  });

  it("allows destructive command when bypass is 1", async () => {
    process.env.DEFT_ALLOW_DESTRUCTIVE_GH_VERBS = "1";
    const { evaluateCommand } = await import("./classifier.js");
    const [code] = evaluateCommand("gh repo delete owner/repo");
    expect(code).toBe(0);
  });

  it("returns exit 0 with allowed-message for a non-destructive command", async () => {
    const { evaluateCommand } = await import("./classifier.js");
    const [code, msg] = evaluateCommand("gh pr merge 123 --squash");
    expect(code).toBe(0);
    expect(msg).toContain("not destructive");
  });

  it("refuses git push origin master without policy", () => {
    const [code, msg] = evaluateCommand("git push origin master");
    expect(code).toBe(1);
    expect(msg).toContain("push_default");
    expect(msg).toContain("deft policy:allow-destructive-gh-verbs -- --confirm");
  });

  it("exits 2 when PROJECT-DEFINITION is missing", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-evalcmd-missing-"));
    const [code, msg] = evaluateCommand("git push origin master", undefined, { projectRoot: r });
    expect(code).toBe(2);
    expect(msg).toContain("cannot be resolved");
    expect(msg).toContain("not found");
  });

  it("exits 2 when plan is not an object", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-evalcmd-plan-"));
    mkdirSync(join(r, "xbrief"), { recursive: true });
    writeFileSync(
      join(r, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: [] }),
      "utf8",
    );
    const [code, msg] = evaluateCommand("git push origin master", undefined, { projectRoot: r });
    expect(code).toBe(2);
    expect(msg).toContain("cannot be resolved");
    expect(msg).toContain("'plan' is not an object");
  });

  it("exits 2 when typed policy is not a boolean", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-evalcmd-bad-"));
    mkdirSync(join(r, "xbrief"), { recursive: true });
    writeFileSync(
      join(r, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "t",
          status: "running",
          "x-directive/policy": { allowDestructiveGhVerbs: "yes" },
        },
      }),
      "utf8",
    );
    const [code, msg] = evaluateCommand("git push origin master", undefined, { projectRoot: r });
    expect(code).toBe(2);
    expect(msg).toContain("must be a boolean");
  });

  it("consults allowDestructiveGhVerbs through projectRoot", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-evalcmd-"));
    mkdirSync(join(r, "xbrief"), { recursive: true });
    writeFileSync(
      join(r, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "t",
          status: "running",
          "x-directive/policy": { allowDestructiveGhVerbs: true },
        },
      }),
      "utf8",
    );
    const [code, msg] = evaluateCommand("git push origin master", undefined, { projectRoot: r });
    expect(code).toBe(0);
    expect(msg).toContain("allowDestructiveGhVerbs=true");
  });
});
