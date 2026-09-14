import { describe, expect, it } from "vitest";
import { extractMarkupFacts } from "./extract-jsdom.js";

describe("jsdom comparison helper (DEV-ONLY)", () => {
  it("extracts a heading for parity comparison", () => {
    expect(extractMarkupFacts("<h1>Ok</h1>", "x.html").map((f) => f.id)).toContain("heading:1:Ok");
  });
});
