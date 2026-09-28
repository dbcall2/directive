import { expect, it } from "vitest";
import { isCeilingArtifactRel, isPresentationPath, normalizeRel, pathExtension } from "./paths.js";

it("recognizes exactly the presentation languages and supplier authority locations", () => {
  for (const path of ["public/index.html", "src/View.tsx", "src/View.jsx", "theme.css"])
    expect(isPresentationPath(path)).toBe(true);
  for (const path of ["src/save.ts", "db/001.sql"]) expect(isPresentationPath(path)).toBe(false);
  expect(isCeilingArtifactRel(".deft/presentation-ceiling.json")).toBe(true);
  expect(isCeilingArtifactRel("xbrief/active/story.xbrief.json")).toBe(true);
  expect(isCeilingArtifactRel("xbrief/completed/story.xbrief.json")).toBe(false);
  expect(isCeilingArtifactRel(".deft/presentation-ceilings/a.json")).toBe(false);
  expect(pathExtension("Views/Home/Index.CSHTML")).toBe(".cshtml");
  expect(normalizeRel("./src\\View.tsx")).toBe("src/View.tsx");
});
