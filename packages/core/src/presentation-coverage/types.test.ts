import { expect, it } from "vitest";
import { BUILTIN_PRESENTATION_EXTENSIONS, PRESENTATION_CEILING_ARTIFACT_REL } from "./types.js";

it("shares supplier artifact path and built-in extension boundary", () => {
  expect(PRESENTATION_CEILING_ARTIFACT_REL).toBe(".deft/presentation-ceiling.json");
  expect(BUILTIN_PRESENTATION_EXTENSIONS).toEqual([".html", ".jsx", ".tsx", ".css"]);
});
