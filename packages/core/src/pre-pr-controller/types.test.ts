import { describe, expect, it } from "vitest";
import {
  allow,
  deny,
  inputBindingHash,
  PRE_PR_EXECUTION_SCHEMA,
  sha256Hex,
  utcIso,
} from "./types.js";

describe("pre-pr execution types", () => {
  it("hashes bindings stably and returns decision tuples", () => {
    const binding = {
      repo: "deftai/directive",
      baseSha: "a",
      headSha: "b",
      treeHash: "c",
      prBodyHash: "d",
      criteriaDigest: "e",
      skillVersion: "0.1",
      policyVersion: "1",
      controllerVersion: "1",
      approvedRevisionSha: "a",
    };
    expect(inputBindingHash(binding)).toBe(inputBindingHash({ ...binding }));
    expect(inputBindingHash({ ...binding, headSha: "z" })).not.toBe(inputBindingHash(binding));
    expect(sha256Hex("x")).toHaveLength(64);
    expect(deny("deny-missing-record", "gone").ok).toBe(false);
    expect(allow("allow-pass", "ok").ok).toBe(true);
    expect(PRE_PR_EXECUTION_SCHEMA).toBe("deft.pre-pr-execution.v1");
    expect(utcIso(new Date("2026-01-01T00:00:00.123Z"))).toBe("2026-01-01T00:00:00Z");
  });
});
