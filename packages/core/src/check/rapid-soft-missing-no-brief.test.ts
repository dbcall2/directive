import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isSoftMissingAcText,
  projectHasLifecycleBrief,
  rapidCheckWarnsSoftMissingNoBrief,
  sessionRecordedProductWrite,
} from "./rapid-soft-missing-no-brief.js";

const SOFT_MISSING = "verify:ac skipped (#3284 soft-missing): no active xBRIEF in xbrief/active/\n";

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rapid-no-brief-"));
  tempDirs.push(root);
  return root;
}

describe("rapidCheckWarnsSoftMissingNoBrief (#4544)", () => {
  it("warns only on rapid product-AC soft-skip with product writes and no brief", () => {
    expect(
      rapidCheckWarnsSoftMissingNoBrief({
        mode: "rapid",
        gateId: "verify:ac",
        acText: SOFT_MISSING,
        hasLifecycleBrief: false,
        sessionChangedProductFiles: true,
      }),
    ).toBe(true);
  });

  it("does not warn when a brief exists, mode is full, or no product write", () => {
    expect(
      rapidCheckWarnsSoftMissingNoBrief({
        mode: "rapid",
        gateId: "verify:ac",
        acText: SOFT_MISSING,
        hasLifecycleBrief: true,
        sessionChangedProductFiles: true,
      }),
    ).toBe(false);
    expect(
      rapidCheckWarnsSoftMissingNoBrief({
        mode: "full",
        gateId: "verify:ac",
        acText: SOFT_MISSING,
        hasLifecycleBrief: false,
        sessionChangedProductFiles: true,
      }),
    ).toBe(false);
    expect(
      rapidCheckWarnsSoftMissingNoBrief({
        mode: "rapid",
        gateId: "verify:ac",
        acText: SOFT_MISSING,
        hasLifecycleBrief: false,
        sessionChangedProductFiles: false,
      }),
    ).toBe(false);
    expect(
      rapidCheckWarnsSoftMissingNoBrief({
        mode: "rapid",
        gateId: "verify:branch",
        acText: SOFT_MISSING,
        hasLifecycleBrief: false,
        sessionChangedProductFiles: true,
      }),
    ).toBe(false);
    expect(isSoftMissingAcText("verify:ac passed (#3284)")).toBe(false);
  });

  it("detects a proposed brief and occupancy last_write_at", () => {
    const withBrief = tempRoot();
    mkdirSync(join(withBrief, "xbrief", "proposed"), { recursive: true });
    writeFileSync(
      join(withBrief, "xbrief", "proposed", "2026-09-23-spike.xbrief.json"),
      "{}",
      "utf8",
    );
    expect(projectHasLifecycleBrief(withBrief)).toBe(true);

    const empty = tempRoot();
    mkdirSync(join(empty, "xbrief", "proposed"), { recursive: true });
    expect(projectHasLifecycleBrief(empty)).toBe(false);

    const wrote = tempRoot();
    mkdirSync(join(wrote, ".deft"), { recursive: true });
    writeFileSync(
      join(wrote, ".deft", "occupancy.json"),
      JSON.stringify({ last_write_at: "2026-09-23T12:00:00Z" }),
      "utf8",
    );
    expect(sessionRecordedProductWrite(wrote)).toBe(true);
    expect(sessionRecordedProductWrite(empty)).toBe(false);
  });
});
