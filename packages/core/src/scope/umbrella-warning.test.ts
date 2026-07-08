import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTransition } from "./transition.js";
import { scopeCompleteUmbrellaWarnings } from "./umbrella-warning.js";
import { formatVbriefJson } from "./vbrief-json.js";

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "scope-umbrella-"));
  for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
    mkdirSync(join(root, "xbrief", folder), { recursive: true });
  }
  return root;
}

function writeScope(
  root: string,
  folder: string,
  name: string,
  plan: Record<string, unknown>,
): string {
  const path = join(root, "xbrief", folder, name);
  writeFileSync(path, formatVbriefJson({ plan }), "utf8");
  return path;
}

function writeCachedIssue(
  root: string,
  number: number,
  issue: {
    readonly title?: string;
    readonly state?: string;
    readonly labels?: readonly string[];
    readonly body?: string;
  } = {},
): void {
  const dir = join(root, ".deft-cache", "github-issue", "deftai", "directive", String(number));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "raw.json"),
    JSON.stringify(
      {
        number,
        title: issue.title ?? `Issue ${number}`,
        state: issue.state ?? "open",
        labels: (issue.labels ?? []).map((name) => ({ name })),
        body: issue.body ?? "",
      },
      null,
      2,
    ),
    "utf8",
  );
}

function writeRawCachedIssue(root: string, number: number, raw: unknown): void {
  const dir = join(root, ".deft-cache", "github-issue", "deftai", "directive", String(number));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "raw.json"), JSON.stringify(raw, null, 2), "utf8");
}

describe("scope complete umbrella warnings", () => {
  let root = "";

  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("warns when an open umbrella xBRIEF references the completed scope", () => {
    root = makeRepo();
    writeCachedIssue(root, 1119, {
      title: "tracker: umbrella",
      labels: ["meta"],
      body: "open working-set tracker",
    });
    writeCachedIssue(root, 2320, { title: "child scope", state: "closed" });
    const child = writeScope(root, "active", "child.xbrief.json", {
      title: "Child",
      status: "running",
      items: [],
      references: [
        { type: "x-vbrief/github-issue", uri: "https://github.com/deftai/directive/issues/2320" },
      ],
    });
    writeScope(root, "active", "umbrella.xbrief.json", {
      title: "Umbrella",
      status: "running",
      items: [],
      references: [
        { type: "x-vbrief/github-issue", uri: "https://github.com/deftai/directive/issues/1119" },
        { type: "x-vbrief/plan", uri: "active/child.xbrief.json" },
      ],
    });

    const result = runTransition("complete", child);

    expect(result.ok).toBe(true);
    expect(result.message).toContain("referenced by OPEN umbrella #1119");
    expect(result.message).toContain("task vbrief:reconcile:umbrellas");
  });

  it("warns when a cached open umbrella body lists the completed scope issue", () => {
    root = makeRepo();
    writeCachedIssue(root, 1119, {
      title: "working-set tracker",
      body: "Current shape still includes #2320 as in-flight.",
    });
    writeCachedIssue(root, 2320, { title: "child scope", state: "closed" });
    const child = writeScope(root, "active", "child.xbrief.json", {
      title: "Child",
      status: "running",
      items: [],
      references: [
        { type: "x-vbrief/github-issue", uri: "https://github.com/deftai/directive/issues/2320" },
      ],
    });

    const result = runTransition("complete", child);

    expect(result.ok).toBe(true);
    expect(result.message).toContain("referenced by OPEN umbrella #1119");
  });

  it("warns when an open umbrella xBRIEF references the completed issue directly", () => {
    root = makeRepo();
    writeRawCachedIssue(root, 1119, {
      number: 1119,
      title: 1119,
      state: "OPEN",
      labels: ["tracker"],
      body: null,
    });
    writeCachedIssue(root, 2320, { title: "child scope", state: "closed" });
    writeFileSync(join(root, "xbrief", "pending", "broken.xbrief.json"), "{", "utf8");
    writeFileSync(
      join(root, "xbrief", "pending", "missing-plan.xbrief.json"),
      JSON.stringify({ nope: true }),
      "utf8",
    );
    const child = writeScope(root, "active", "child.xbrief.json", {
      title: "Child",
      status: "running",
      items: [],
      references: [
        { type: "x-xbrief/github-issue", uri: "https://github.com/deftai/directive/issues/2320" },
      ],
    });
    writeScope(root, "pending", "umbrella.xbrief.json", {
      title: "Umbrella",
      status: "pending",
      items: [],
      references: [
        { type: "x-xbrief/github-issue", uri: "https://github.com/deftai/directive/issues/1119" },
        { type: "x-xbrief/github-issue", uri: "https://github.com/deftai/directive/issues/2320" },
      ],
    });

    const result = runTransition("complete", child);

    expect(result.ok).toBe(true);
    expect(result.message).toContain("referenced by OPEN umbrella #1119");
  });

  it("warns for cached umbrella issue URLs and skips malformed cache entries", () => {
    root = makeRepo();
    writeCachedIssue(root, 1119, {
      title: "release umbrella",
      body: "Current shape points at https://github.com/deftai/directive/issues/2320/.",
    });
    const malformedDir = join(root, ".deft-cache", "github-issue", "deftai", "directive", "2222");
    mkdirSync(malformedDir, { recursive: true });
    writeFileSync(join(malformedDir, "raw.json"), "{", "utf8");
    writeRawCachedIssue(root, 3333, null);
    mkdirSync(join(root, ".deft-cache", "github-issue", "deftai", "directive", "not-a-number"), {
      recursive: true,
    });
    const child = writeScope(root, "active", "child.xbrief.json", {
      title: "Child",
      status: "running",
      items: [],
      references: [
        { type: "x-xbrief/github-issue", uri: "https://github.com/deftai/directive/issues/2320" },
      ],
    });

    const result = runTransition("complete", child);

    expect(result.ok).toBe(true);
    expect(result.message).toContain("referenced by OPEN umbrella #1119");
  });

  it("returns no warnings when completion data has no plan", () => {
    root = makeRepo();

    expect(
      scopeCompleteUmbrellaWarnings({
        projectRoot: root,
        vbriefRoot: join(root, "xbrief"),
        oldPath: join(root, "xbrief", "active", "missing.xbrief.json"),
        newPath: join(root, "xbrief", "completed", "missing.xbrief.json"),
        scopeData: {},
      }),
    ).toEqual([]);
  });

  it("does not warn for closed umbrella references", () => {
    root = makeRepo();
    writeCachedIssue(root, 1119, {
      title: "tracker: umbrella",
      state: "closed",
      body: "Current shape includes #2320.",
    });
    writeCachedIssue(root, 2320, { title: "child scope", state: "closed" });
    const child = writeScope(root, "active", "child.xbrief.json", {
      title: "Child",
      status: "running",
      items: [],
      references: [
        { type: "x-vbrief/github-issue", uri: "https://github.com/deftai/directive/issues/2320" },
      ],
    });

    const result = runTransition("complete", child);

    expect(result.ok).toBe(true);
    expect(result.message).not.toContain("OPEN umbrella");
    expect(readFileSync(join(root, "xbrief", "completed", "child.xbrief.json"), "utf8")).toContain(
      '"completed"',
    );
  });
});
