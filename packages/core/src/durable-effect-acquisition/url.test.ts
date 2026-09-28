import { describe, expect, it } from "vitest";
import {
  classifyLiteralUrlValue,
  listBoundaryInText,
  preprocessUrlInput,
  resolveAgainstSentinel,
  templateHeadPinsOrigin,
} from "./url.js";

describe("url preprocessing (#5080 item 3)", () => {
  it("trims C0-or-space then strips tab/LF/CR", () => {
    expect(preprocessUrlInput(" \u0001http:collector.example/p")).toBe("http:collector.example/p");
    expect(preprocessUrlInput("https:/\n/collector.example/p")).toBe("https://collector.example/p");
    expect(preprocessUrlInput("https:/\t/collector.example/c")).toBe("https://collector.example/c");
  });

  it("refuses request-capable non-sentinel origins and continues same-origin and mailto", () => {
    expect(classifyLiteralUrlValue("https://collector.example/p", "item-3", [])?.detail).toMatch(
      /collector/,
    );
    expect(classifyLiteralUrlValue("/img/a.png", "item-3", [])).toBeNull();
    expect(classifyLiteralUrlValue("mailto:hi@example.com", "item-3", [])).toBeNull();
    expect(classifyLiteralUrlValue("md:flex hover:bg-red-500", "item-3", [])).toBeNull();
    expect(classifyLiteralUrlValue("data:image/png;base64,aaa", "item-3", [])?.detail).toMatch(
      /origin/,
    );
    expect(classifyLiteralUrlValue("blob:https://deft.invalid/id", "item-3", [])).toBeNull();
    expect(classifyLiteralUrlValue("blob:null/id", "item-3", [])?.detail).toMatch(/origin/);
    expect(
      classifyLiteralUrlValue("blob:https://collector.example/id", "item-3", [])?.detail,
    ).toMatch(/collector/);
  });

  it("splits list candidates so srcset second tokens refuse", () => {
    const hit = classifyLiteralUrlValue(
      "/safe.png 1x, https://collector.example/p?u=demo 2x",
      "item-3",
      [],
    );
    expect(hit?.detail).toMatch(/collector/);
  });

  it("pins a template head only after a path has begun", () => {
    expect(templateHeadPinsOrigin("/\\collector/")).toBe(false);
    expect(templateHeadPinsOrigin("https://collector/")).toBe(false);
    expect(templateHeadPinsOrigin("//collector/")).toBe(false);
    expect(templateHeadPinsOrigin("relative:part/path")).toBe(false);
    expect(templateHeadPinsOrigin("/img/")).toBe(true);
    expect(templateHeadPinsOrigin("images/")).toBe(true);
    expect(templateHeadPinsOrigin("./p/")).toBe(true);
    expect(templateHeadPinsOrigin("/")).toBe(false);
    expect(templateHeadPinsOrigin("https")).toBe(false);
    expect(templateHeadPinsOrigin(" /")).toBe(false);
    expect(templateHeadPinsOrigin("")).toBe(false);
  });

  it("detects list boundaries after preprocessing", () => {
    expect(listBoundaryInText("/img/a.png 1x, ")).toBe(true);
    expect(listBoundaryInText("/img/")).toBe(false);
  });

  it("resolves protocol-relative tokens as non-sentinel https", () => {
    expect(resolveAgainstSentinel("http://[").ok).toBe(false);
    expect(classifyLiteralUrlValue("http://[", "item-3", [])?.detail).toMatch(/URL|Invalid/i);
    const r = resolveAgainstSentinel("//collector.example/c");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.origin).toBe("https://collector.example");
  });
});
