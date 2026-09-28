import { describe, expect, it } from "vitest";
import {
  IN_CLASS_EXT,
  isInertNativeAttribute,
  PRESENTATION_CEILING_ARTIFACT_REL,
  PRESENTATION_CEILING_SCHEMA,
  REQUEST_CAPABLE_SCHEMES,
  SENTINEL_ORIGIN,
} from "./types.js";

describe("durable-effect-acquisition types (#5080)", () => {
  it("pins the ceiling artifact path and schema", () => {
    expect(PRESENTATION_CEILING_ARTIFACT_REL).toBe(".deft/presentation-ceiling.json");
    expect(PRESENTATION_CEILING_SCHEMA).toBe("deft.presentation-ceiling.v1");
    expect(SENTINEL_ORIGIN).toBe("https://deft.invalid");
  });

  it("treats html/jsx/tsx as in-class and keeps the request-capable scheme set closed", () => {
    expect(IN_CLASS_EXT.test("src/A.tsx")).toBe(true);
    expect(IN_CLASS_EXT.test("src/A.ts")).toBe(false);
    expect(REQUEST_CAPABLE_SCHEMES).toContain("https");
    expect(REQUEST_CAPABLE_SCHEMES).toContain("javascript");
    expect(REQUEST_CAPABLE_SCHEMES).not.toContain("mailto");
    expect(isInertNativeAttribute("srcset")).toBe(false);
    expect(isInertNativeAttribute("title")).toBe(true);
    expect(isInertNativeAttribute("alt")).toBe(true);
  });
});
