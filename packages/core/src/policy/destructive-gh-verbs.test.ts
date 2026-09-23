import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FIELD_ALLOW_DESTRUCTIVE_GH_VERBS,
  FIELD_ALLOW_DESTRUCTIVE_GH_VERBS_CLI_ALIAS,
  inspectAllowDestructiveGhVerbs,
  resolveAllowDestructiveGhVerbs,
  setAllowDestructiveGhVerbs,
} from "./destructive-gh-verbs.js";
import { inspectAllPolicies, inspectOnePolicy, registeredPolicyNames } from "./index.js";

function writePd(root: string, policy: Record<string, unknown>): void {
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "t",
        status: "running",
        "x-directive/policy": policy,
      },
    }),
    "utf8",
  );
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "deft-dgh-"));
}

describe("resolveAllowDestructiveGhVerbs", () => {
  it("defaults fail-closed when the field is absent", () => {
    const r = tempRoot();
    writePd(r, {});
    const p = resolveAllowDestructiveGhVerbs(r);
    expect(p.allowDestructiveGhVerbs).toBe(false);
    expect(p.source).toBe("default-fail-closed");
    expect(p.error).toBeNull();
  });

  it("honors typed true", () => {
    const r = tempRoot();
    writePd(r, { allowDestructiveGhVerbs: true });
    const p = resolveAllowDestructiveGhVerbs(r);
    expect(p.allowDestructiveGhVerbs).toBe(true);
    expect(p.source).toBe("typed");
  });

  it("honors typed false", () => {
    const r = tempRoot();
    writePd(r, { allowDestructiveGhVerbs: false });
    const p = resolveAllowDestructiveGhVerbs(r);
    expect(p.allowDestructiveGhVerbs).toBe(false);
    expect(p.source).toBe("typed");
  });

  it("fail-closes a non-boolean typed value", () => {
    const r = tempRoot();
    writePd(r, { allowDestructiveGhVerbs: "yes" });
    const p = resolveAllowDestructiveGhVerbs(r);
    expect(p.allowDestructiveGhVerbs).toBe(false);
    expect(p.source).toBe("default-fail-closed");
    expect(p.error).toContain("must be a boolean");
  });

  it("fail-closes when PROJECT-DEFINITION is missing", () => {
    const r = tempRoot();
    const p = resolveAllowDestructiveGhVerbs(r);
    expect(p.allowDestructiveGhVerbs).toBe(false);
    expect(p.source).toBe("default-fail-closed");
    expect(p.error).toContain("not found");
  });
});

describe("setAllowDestructiveGhVerbs", () => {
  it("writes true and audits", () => {
    const r = tempRoot();
    writePd(r, {});
    const result = setAllowDestructiveGhVerbs(r, {
      allowDestructiveGhVerbs: true,
      actor: "test",
      note: "bootstrap",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(resolveAllowDestructiveGhVerbs(r).allowDestructiveGhVerbs).toBe(true);
    const log = readFileSync(join(r, "meta", "policy-changes.log"), "utf8");
    expect(log).toContain("allowDestructiveGhVerbs=true");
    expect(log).toContain("note=bootstrap");
  });

  it("no-ops when the value already matches", () => {
    const r = tempRoot();
    writePd(r, { allowDestructiveGhVerbs: true });
    const result = setAllowDestructiveGhVerbs(r, { allowDestructiveGhVerbs: true, actor: "test" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
  });

  it("returns not-found without throwing", () => {
    const r = tempRoot();
    const result = setAllowDestructiveGhVerbs(r, { allowDestructiveGhVerbs: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("not found");
  });

  it("refuses when plan is not an object", () => {
    const r = tempRoot();
    mkdirSync(join(r, "xbrief"), { recursive: true });
    writeFileSync(
      join(r, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: [] }),
      "utf8",
    );
    const result = setAllowDestructiveGhVerbs(r, { allowDestructiveGhVerbs: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("'plan' is not an object");
  });

  it("refuses when namespaced policy is not an object", () => {
    const r = tempRoot();
    mkdirSync(join(r, "xbrief"), { recursive: true });
    writeFileSync(
      join(r, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "t", status: "running", "x-directive/policy": "nope" },
      }),
      "utf8",
    );
    const result = setAllowDestructiveGhVerbs(r, { allowDestructiveGhVerbs: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("plan.policy is not an object");
  });
});

describe("inspectAllowDestructiveGhVerbs", () => {
  it("is registered for policy:show", () => {
    expect(registeredPolicyNames()).toContain(FIELD_ALLOW_DESTRUCTIVE_GH_VERBS);
    const r = tempRoot();
    writePd(r, { allowDestructiveGhVerbs: true });
    expect(inspectOnePolicy(FIELD_ALLOW_DESTRUCTIVE_GH_VERBS, r)?.current).toBe(true);
    expect(inspectOnePolicy(FIELD_ALLOW_DESTRUCTIVE_GH_VERBS_CLI_ALIAS, r)?.current).toBe(true);
    expect(inspectAllPolicies(r).some((f) => f.name === FIELD_ALLOW_DESTRUCTIVE_GH_VERBS)).toBe(
      true,
    );
  });

  it("inspect(null) reports default without a project root", () => {
    const field = inspectAllowDestructiveGhVerbs(null);
    expect(field.name).toBe(FIELD_ALLOW_DESTRUCTIVE_GH_VERBS);
    expect(field.current).toBe(false);
    expect(field.source).toBe("default");
  });

  it("inspects typed data without a project root", () => {
    const field = inspectAllowDestructiveGhVerbs({
      plan: { "x-directive/policy": { allowDestructiveGhVerbs: true } },
    });
    expect(field.current).toBe(true);
    expect(field.source).toBe("typed");
  });
});
