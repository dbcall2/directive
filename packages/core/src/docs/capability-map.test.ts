import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CONSUMER_CHECK_GATES, checkGateId, FRAMEWORK_CHECK_GATES } from "../check/gate-lists.js";
import {
  AUDIENCES,
  CANONICAL_KINDS,
  CHANGE_CLASSES,
  capabilityMapMain,
  evaluateCapabilityMap,
  GOTCHA_MAX_CHARS,
  INDEX_REL,
  OVERLAY_REL,
  isPublicIndexMember,
  loadCapabilityRegistries,
  loadOverlayFile,
  loadSkillRegistry,
  type OverlayEntry,
  type OverlayFile,
  parseCapabilityMapArgs,
  parseOverlayJson,
  renderCapabilityIndex,
  STATUSES,
} from "./capability-map.js";

const emptyRegistries = {
  commands: new Set<string>(["check", "session:start"]),
  skills: new Set<string>(["deft-directive-setup"]),
  skillTriggers: new Set<string>(["deft-directive-setup", "build"]),
  helpKeys: new Set<string>(["task triage:summary"]),
  docsSitePages: new Set<string>(["docs-site/index.html"]),
};

function entry(partial: Partial<OverlayEntry> & Pick<OverlayEntry, "id" | "title">): OverlayEntry {
  return {
    audience: "consumer",
    status: "current",
    in_the_public_index: true,
    canonical_entry: { kind: "command", id: "check" },
    gotchas: "Run task check before merge.",
    ...partial,
  };
}

describe("capability overlay taxonomy (#4099)", () => {
  it("locks closed audience/status/kind/change-class enums", () => {
    expect(AUDIENCES).toEqual(["consumer", "maintainer", "frozen"]);
    expect(STATUSES).toEqual(["current", "compatibility", "withdrawn", "experimental"]);
    expect(CANONICAL_KINDS).toEqual(["command", "skill-trigger", "document", "none"]);
    expect(CHANGE_CLASSES).toEqual(["add", "change", "withdraw"]);
  });

  it("uses the membership predicate, not editorial major", () => {
    expect(
      isPublicIndexMember(
        entry({ id: "a", title: "A", in_the_public_index: true, status: "current" }),
      ),
    ).toBe(true);
    expect(
      isPublicIndexMember(
        entry({ id: "b", title: "B", in_the_public_index: true, status: "compatibility" }),
      ),
    ).toBe(true);
    expect(
      isPublicIndexMember(
        entry({ id: "c", title: "C", in_the_public_index: true, status: "withdrawn" }),
      ),
    ).toBe(false);
    expect(
      isPublicIndexMember(
        entry({
          id: "d",
          title: "D",
          in_the_public_index: true,
          canonical_entry: { kind: "none", id: "" },
        }),
      ),
    ).toBe(false);
    expect(isPublicIndexMember(entry({ id: "e", title: "E", in_the_public_index: false }))).toBe(
      false,
    );
  });

  it("requires experimental status_owner and rejects unknown audience", () => {
    const experimental = parseOverlayJson(
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: "exp",
            title: "Experimental",
            audience: "consumer",
            status: "experimental",
            in_the_public_index: false,
            canonical_entry: { kind: "command", id: "check" },
            gotchas: "Owned.",
          },
        ],
      }),
    );
    expect(experimental.errors.some((e) => e.includes("status_owner"))).toBe(true);

    const badAudience = parseOverlayJson(
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: "x",
            title: "X",
            audience: "major",
            status: "current",
            in_the_public_index: true,
            canonical_entry: { kind: "command", id: "check" },
            gotchas: "nope",
          },
        ],
      }),
    );
    expect(badAudience.overlay).toBeNull();
    expect(badAudience.errors.some((e) => e.includes("audience"))).toBe(true);
  });

  it("bounds gotchas as quoted overlay data without scoring prose", () => {
    const tooLong = parseOverlayJson(
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: "long",
            title: "Long",
            audience: "consumer",
            status: "current",
            in_the_public_index: true,
            canonical_entry: { kind: "command", id: "check" },
            gotchas: "x".repeat(GOTCHA_MAX_CHARS + 1),
          },
        ],
      }),
    );
    expect(tooLong.errors.some((e) => e.includes("gotchas exceeds"))).toBe(true);
  });
});

describe("capability map check (#4099)", () => {
  it("fails when overlay commands are missing from #4094 registries", () => {
    const overlay: OverlayFile = {
      version: 1,
      entries: [
        entry({
          id: "missing",
          title: "Missing",
          canonical_entry: { kind: "command", id: "nope" },
        }),
      ],
    };
    const result = evaluateCapabilityMap({ overlay, registries: emptyRegistries });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("nope"))).toBe(true);
  });

  it("fails when the generated page is stale", () => {
    const overlay: OverlayFile = {
      version: 1,
      entries: [entry({ id: "check", title: "Check" })],
    };
    const markdown = renderCapabilityIndex(overlay);
    const stale = evaluateCapabilityMap({
      overlay,
      registries: emptyRegistries,
      committedMarkdown: "stale\n",
    });
    expect(stale.ok).toBe(false);
    expect(stale.errors.some((e) => e.includes("STALE"))).toBe(true);
    const fresh = evaluateCapabilityMap({
      overlay,
      registries: emptyRegistries,
      committedMarkdown: markdown,
    });
    expect(fresh.ok).toBe(true);
    expect(markdown).toContain("### Check");
    expect(markdown).not.toContain("editorial major");
  });

  it("omits withdrawn, experimental, and kind none from the generated index", () => {
    const overlay: OverlayFile = {
      version: 1,
      entries: [
        entry({ id: "check", title: "Check" }),
        entry({
          id: "gone",
          title: "Gone",
          status: "withdrawn",
          in_the_public_index: true,
          canonical_entry: { kind: "skill-trigger", id: "deft-directive-setup" },
        }),
        entry({
          id: "none-kind",
          title: "None kind",
          canonical_entry: { kind: "none", id: "" },
        }),
      ],
    };
    const markdown = renderCapabilityIndex(overlay);
    expect(markdown).toContain("### Check");
    expect(markdown).not.toContain("### Gone");
    expect(markdown).not.toContain("### None kind");
    expect(markdown).toContain("#447");
  });

  it("parses --check and --project-root", () => {
    expect(parseCapabilityMapArgs(["--check", "--project-root", "/tmp/repo"])).toMatchObject({
      check: true,
      projectRoot: "/tmp/repo",
      error: null,
    });
  });
});

describe("framework gate wiring (#4099)", () => {
  it("places docs:capability-map:check on the framework list only", () => {
    expect(FRAMEWORK_CHECK_GATES.map(checkGateId)).toContain("docs:capability-map:check");
    expect(CONSUMER_CHECK_GATES.map(checkGateId)).not.toContain("docs:capability-map:check");
  });

  it("lists docs:capability-map:check in Taskfile check:framework-source", () => {
    const repoRoot = resolve(import.meta.dirname, "..", "..", "..", "..");
    const taskfile = readFileSync(join(repoRoot, "Taskfile.yml"), "utf8");
    const start = taskfile.indexOf("check:framework-source:");
    const rest = taskfile.slice(start);
    const cmds = rest.indexOf("cmds:");
    const deps = cmds === -1 ? rest : rest.slice(0, cmds);
    expect(deps).toContain("- docs:capability-map:check");
  });
});

describe("live overlay against #4094 registries", () => {
  it("resolves committed overlay commands through loadCommandRegistries", () => {
    const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
    const registries = loadCapabilityRegistries(repoRoot);
    expect(registries.commands.has("session:start")).toBe(true);
    expect(registries.commands.has("docs:rule-map")).toBe(true);
    expect(registries.skills.has("deft-directive-setup")).toBe(true);
    expect(registries.docsSitePages.has("docs-site/index.html")).toBe(true);
    expect(registries.helpKeys.has("task triage:summary")).toBe(true);
    const loaded = parseOverlayJson(readFileSync(join(repoRoot, OVERLAY_REL), "utf8"));
    expect(loaded.overlay).not.toBeNull();
    if (loaded.overlay === null) return;
    expect(basename(INDEX_REL)).toBe("capabilities.md");
    const committed = readFileSync(join(repoRoot, INDEX_REL), "utf8");
    const result = evaluateCapabilityMap({
      overlay: loaded.overlay,
      registries,
      committedMarkdown: committed,
    });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("does not treat a missing overlay in a temp tree as a registry miss", () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-map-"));
    writeFileSync(join(dir, "empty.txt"), "x");
    const parsed = parseOverlayJson('{"version":1,"entries":[]}');
    expect(parsed.overlay).not.toBeNull();
    if (parsed.overlay === null) return;
    const result = evaluateCapabilityMap({
      overlay: parsed.overlay,
      registries: emptyRegistries,
    });
    expect(result.ok).toBe(true);
    expect(result.markdown).toContain("# Capability index");
  });

  it("capabilityMapMain --check exits 0 on the live overlay", () => {
    const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
    expect(capabilityMapMain(["--help"])).toBe(0);
    expect(parseCapabilityMapArgs(["--project-root"]).error).toContain("--project-root");
    expect(parseCapabilityMapArgs(["--nope"]).error).toContain("unrecognized");
    expect(loadOverlayFile(mkdtempSync(join(tmpdir(), "cap-missing-"))).overlay).toBeNull();
    expect(capabilityMapMain(["--check", "--project-root", repoRoot])).toBe(0);
  });

  it("rejects overlay JSON that is not an object and unresolved skill/document ids", () => {
    expect(parseOverlayJson("[").overlay).toBeNull();
    expect(parseOverlayJson("[]").errors[0]).toContain("JSON object");
    const overlay: OverlayFile = {
      version: 1,
      entries: [
        entry({
          id: "skill-miss",
          title: "Skill miss",
          canonical_entry: { kind: "skill-trigger", id: "no-such-skill" },
        }),
        entry({
          id: "doc-miss",
          title: "Doc miss",
          canonical_entry: { kind: "document", id: "docs-site/nope.html" },
        }),
      ],
    };
    const result = evaluateCapabilityMap({ overlay, registries: emptyRegistries });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("skill-trigger"))).toBe(true);
    expect(result.errors.some((e) => e.includes("docs-site"))).toBe(true);
  });

  it("loadSkillRegistry ignores null JSON without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-null-"));
    const packDir = join(dir, "content", "packs", "skills");
    mkdirSync(packDir, { recursive: true });
    writeFileSync(join(packDir, "skills-pack-0.1.json"), "null");
    expect(loadSkillRegistry(dir).skills.size).toBe(0);
  });
});
