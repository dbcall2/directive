import { describe, expect, it } from "vitest";
import {
  buildObservableScopeRecord,
  computeContractDigest,
  parseObservableChangeContract,
  parseObservableScopeRecord,
} from "./mint.js";

const human = {
  kind: "operator" as const,
  actor: "david",
  mintedAt: "2026-09-13T00:00:00Z",
  mintedVia: "scope:record-observable-scope",
};

describe("observable-scope mint record (#4495)", () => {
  it("refuses worker-declared baselineRef and URL designApprovalRef", () => {
    const rec = buildObservableScopeRecord({
      planId: "story",
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      allowedChanges: [{ kind: "control", op: "add", name: "email" }],
      humanApproval: human,
    });
    expect("error" in rec).toBe(false);
    if ("error" in rec) return;
    expect(parseObservableScopeRecord({ ...rec, baselineRef: "HEAD~1" })).toMatchObject({
      error: expect.stringMatching(/baselineRef/),
    });
    expect(
      parseObservableScopeRecord({ ...rec, designApprovalRef: "https://example.test" }),
    ).toMatchObject({
      error: expect.stringMatching(/designApprovalRef/),
    });
  });

  it("refuses agent stamps", () => {
    const rec = buildObservableScopeRecord({
      planId: "story",
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      allowedChanges: [{ kind: "control", op: "add", name: "email" }],
      humanApproval: { kind: "agent", actor: "agent:leaf", mintedAt: "2026-09-13T00:00:00Z" },
    });
    expect(rec).toMatchObject({ error: expect.stringMatching(/human-presence/) });
  });

  it("accepts namespaced contract without baselineRef", () => {
    const parsed = parseObservableChangeContract({
      changeKind: "fields-only",
      allowedChanges: [{ kind: "control", op: "add", name: "email" }],
    });
    expect("error" in parsed).toBe(false);
  });

  it("pins contractDigest", () => {
    const allowedChanges = [{ kind: "control" as const, op: "add" as const, name: "email" }];
    const rec = buildObservableScopeRecord({
      planId: "story",
      xbriefRelPath: "xbrief/active/story.xbrief.json",
      allowedChanges,
      humanApproval: human,
    });
    expect("error" in rec).toBe(false);
    if ("error" in rec) return;
    expect(rec.contractDigest).toBe(computeContractDigest({ allowedChanges }));
    expect(parseObservableScopeRecord({ ...rec, contractDigest: "deadbeef" })).toMatchObject({
      error: expect.stringMatching(/contractDigest/),
    });
  });
});
