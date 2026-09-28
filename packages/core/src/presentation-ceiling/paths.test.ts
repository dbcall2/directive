import { describe, expect, it } from "vitest";
import {
  isCeilingArtifactRel,
  isCssPath,
  isPresentationPath,
  normalizeExtensionToken,
  pathExtension,
} from "./paths.js";

describe("presentation-ceiling paths (#5056 / #5079 item 9)", () => {
  it("matches isMarkupPath plus css", () => {
    expect(isPresentationPath("src/View.tsx")).toBe(true);
    expect(isPresentationPath("public/index.html")).toBe(true);
    expect(isCssPath("theme.css")).toBe(true);
    expect(isPresentationPath("theme.css")).toBe(true);
    expect(isPresentationPath("src/save.ts")).toBe(false);
    expect(isPresentationPath("db/001.sql")).toBe(false);
  });

  it("recognizes the ceiling artifact store", () => {
    expect(isCeilingArtifactRel(".deft/presentation-ceilings/a.json")).toBe(true);
    expect(isCeilingArtifactRel(".deft/operator-scope-ceiling.json")).toBe(false);
    expect(pathExtension("Views/Home/Index.cshtml")).toBe(".cshtml");
    expect(normalizeExtensionToken("sql")).toBe(".sql");
  });
});
