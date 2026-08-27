import { describe, expect, it } from "vitest";
import { routeArgv, TOP_LEVEL_UX_VERBS } from "./route-argv.js";

describe("route-argv: migrate top-level verb (#1941)", () => {
  it("registers migrate in the #1670 top-level UX vocabulary", () => {
    expect(TOP_LEVEL_UX_VERBS).toContain("migrate");
  });

  it("routes `migrate` to a dispatch with the migrate verb preserved", () => {
    const routed = routeArgv(["migrate"]);
    expect(routed.kind).toBe("dispatch");
    expect(routed.argv).toEqual(["migrate"]);
  });

  it("forwards trailing args to the migrate handler", () => {
    const routed = routeArgv(["migrate", "--repo-root", "/tmp/x", "--json"]);
    expect(routed.kind).toBe("dispatch");
    expect(routed.argv).toEqual(["migrate", "--repo-root", "/tmp/x", "--json"]);
  });

  it("routes migrate the same way as init and update (parallel branch)", () => {
    expect(routeArgv(["init"]).argv).toEqual(["init"]);
    expect(routeArgv(["update"]).argv).toEqual(["update"]);
    expect(routeArgv(["migrate"]).argv).toEqual(["migrate"]);
  });

  it("every curated top-level UX verb routes as dispatch or stub", () => {
    for (const verb of TOP_LEVEL_UX_VERBS) {
      expect(["dispatch", "stub"]).toContain(routeArgv([verb]).kind);
    }
  });
});

describe("route-argv: setup branch-policy colon verbs (#3609)", () => {
  it("routes the exact setup writer argv without a task-wrapper separator", () => {
    expect(
      routeArgv(["policy:enforce-branches", "--actor", "agent:deft-directive-setup"]).argv,
    ).toEqual(["policy:enforce-branches", "--actor", "agent:deft-directive-setup"]);
    expect(
      routeArgv([
        "policy:allow-direct-commits",
        "--confirm",
        "--actor",
        "agent:deft-directive-setup",
      ]).argv,
    ).toEqual([
      "policy:allow-direct-commits",
      "--confirm",
      "--actor",
      "agent:deft-directive-setup",
    ]);
  });

  it("routes the exact setup read-back and conformance argv", () => {
    expect(
      routeArgv(["policy:show", "--field=plan.policy.allowDirectCommitsToMaster"]).argv,
    ).toEqual(["policy:show", "--field=plan.policy.allowDirectCommitsToMaster"]);
    expect(routeArgv(["verify:vbrief-conformance", "--project-root", "."]).argv).toEqual([
      "verify:vbrief-conformance",
      "--project-root",
      ".",
    ]);
  });
});
